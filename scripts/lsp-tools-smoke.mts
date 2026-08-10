#!/usr/bin/env node
/**
 * Drives the real lsp_* tools against real language servers.
 *
 * The unit tests cover the wire framing and the graceful-degradation path with
 * an empty PATH; nothing until now started a server. That left the parts only a
 * real server can answer untested: whether the handshake we send is one it
 * accepts, whether `didOpen` reaches it before we ask a question, and — the
 * reason this exists — whether the invocation each language's entry names is
 * the one that server actually wants.
 *
 * It runs whichever of its cases has a server on PATH and skips the rest, so a
 * laptop with only typescript-language-server still gets a real check. CI sets
 * SEEKFORGE_REQUIRE_LSP_SMOKE to a comma-separated list of languages that MUST
 * run, so a case silently skipping there is a failure rather than a shrug.
 *
 * Usage: npx tsx scripts/lsp-tools-smoke.mts
 *        SEEKFORGE_REQUIRE_LSP_SMOKE=typescript,java npx tsx scripts/lsp-tools-smoke.mts
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDefaultDispatcher } from "../packages/core/src/tools/index.js";
import { disposeLspServers, jdtlsDataDir, resolveServerCommand } from "../packages/core/src/tools/lsp/client.js";
import type { ToolContext } from "../packages/core/src/tools/index.js";
import type { ToolResult } from "../packages/shared/src/index.js";

type Case = {
  language: string;
  /** Written into a throwaway workspace before anything is asked. */
  files: Record<string, string>;
  /** A file, 1-based line and 0-based column of a USE of the symbol below. */
  use: { path: string; line: number; character: number };
  /** The file and 1-based line the definition is on. */
  definition: { path: string; line: number };
  /** The symbol's name — unique in the workspace, so lsp_symbols can find it. */
  symbol: string;
  /** Anything the server needs present in the workspace before it will start. */
  prepare?: (workspace: string) => void;
  /**
   * Whether `workspace/symbol` can answer for this fixture.
   *
   * jdtls builds its project-wide index from an IMPORTED BUILD — a pom.xml, a
   * Gradle script, an Eclipse .project — and a directory of loose .java files
   * is none of those. Measured: everything scoped to an open document works
   * (outline, definition, references across files), and project-wide search
   * stays empty however long it is polled. That is jdtls's behavior in a
   * buildless directory, not a defect here, and a Java repository with a pom
   * is unaffected. Asserting it anyway would make the smoke encode a false
   * expectation.
   */
  projectWideSearch: boolean;
};

/**
 * typescript-language-server refuses to start without a `typescript` it can
 * resolve from the workspace — "Could not find a valid TypeScript installation"
 * — which is correct behavior and exactly what a real project provides through
 * its own node_modules. The fixture links the one this repository already has
 * rather than installing a second copy, so the smoke measures the language
 * server and not npm.
 */
function linkTypescript(workspace: string): void {
  const modules = join(workspace, "node_modules");
  mkdirSync(modules, { recursive: true });
  const installed = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  symlinkSync(installed, join(modules, "typescript"), "dir");
}

const CASES: Case[] = [
  {
    language: "typescript",
    files: {
      "src/util.ts": "export function seekforgeAdd(a: number, b: number): number {\n  return a + b;\n}\n",
      "src/main.ts": 'import { seekforgeAdd } from "./util.js";\n\nexport const total = seekforgeAdd(1, 2);\n',
      "tsconfig.json": '{ "compilerOptions": { "strict": true, "module": "nodenext", "target": "es2022" } }\n',
    },
    // `export const total = seekforgeAdd(1, 2);` — column 21 lands inside the name.
    use: { path: "src/main.ts", line: 3, character: 21 },
    definition: { path: "src/util.ts", line: 1 },
    symbol: "seekforgeAdd",
    projectWideSearch: true,
    prepare: linkTypescript,
  },
  {
    language: "java",
    files: {
      "Util.java": "public class Util {\n  public static int seekforgeAdd(int a, int b) {\n    return a + b;\n  }\n}\n",
      "Main.java":
        "public class Main {\n  public static void main(String[] args) {\n    System.out.println(Util.seekforgeAdd(1, 2));\n  }\n}\n",
    },
    // `System.out.println(Util.seekforgeAdd(1, 2));` — inside the method name.
    use: { path: "Main.java", line: 3, character: 29 },
    definition: { path: "Util.java", line: 2 },
    symbol: "seekforgeAdd",
    projectWideSearch: false,
  },
];

/** Bound on how long a server may take to finish indexing the whole project. */
const SYMBOL_SEARCH_ATTEMPTS = 15;
const SYMBOL_SEARCH_INTERVAL_MS = 2000;

const dispatcher = createDefaultDispatcher();
let callId = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function run(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const res = await dispatcher.execute({ id: `lsp-smoke-${callId++}`, name, arguments: args }, ctx);
  if (!res.ok) throw new Error(`${name} failed: ${res.error?.code} ${res.error?.message}`);
  return res;
}

/** Whether a server for this language is on PATH. Starts nothing. */
function serverOnPath(samplePath: string): boolean {
  try {
    resolveServerCommand(samplePath);
    return true;
  } catch {
    return false;
  }
}

function makeWorkspace(files: Record<string, string>): string {
  const workspace = mkdtempSync(join(tmpdir(), "seekforge-lsp-smoke-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return workspace;
}

async function exercise(testCase: Case, workspace: string): Promise<void> {
  const ctx: ToolContext = {
    sessionId: `lsp-smoke-${testCase.language}`,
    workspace,
    policy: { approvalMode: "auto", mode: "edit", commandAllowlist: [] },
    confirm: async () => true,
  };

  // Outline first: it is the cheapest question that proves the server started,
  // accepted our initialize, and saw the document we opened.
  const outline = (await run(ctx, "lsp_document_symbols", { path: testCase.definition.path })).data as {
    symbols: { name: string; line: number }[];
  };
  assert(
    outline.symbols.some((s) => s.name.includes(testCase.symbol)),
    `${testCase.language}: outline never mentioned ${testCase.symbol}: ${JSON.stringify(outline.symbols)}`,
  );

  const definitions = (await run(ctx, "lsp_definition", testCase.use)).data as {
    definitions: { path: string; line: number }[];
  };
  assert(definitions.definitions.length > 0, `${testCase.language}: no definition found for ${testCase.symbol}`);
  const hit = definitions.definitions[0]!;
  assert(
    hit.path.endsWith(testCase.definition.path) && hit.line === testCase.definition.line,
    `${testCase.language}: definition landed at ${hit.path}:${hit.line}, expected ${testCase.definition.path}:${testCase.definition.line}`,
  );

  // The definition and the use: a server that only reported one of them would
  // still pass the check above.
  const references = (await run(ctx, "lsp_references", testCase.use)).data as { count: number };
  assert(references.count >= 2, `${testCase.language}: expected the definition and its use, got ${references.count}`);

  // Project-wide search is the one question that needs the WHOLE project
  // indexed, not just the open document, and a server keeps indexing after it
  // has started answering. Polled rather than asked once, with a bound: a
  // server that never gets there is a real failure, one that takes ten seconds
  // is not.
  if (!testCase.projectWideSearch) return;
  let found = false;
  for (let attempt = 0; attempt < SYMBOL_SEARCH_ATTEMPTS && !found; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SYMBOL_SEARCH_INTERVAL_MS));
    const symbols = (await run(ctx, "lsp_symbols", { query: testCase.symbol })).data as {
      symbols: { name: string }[];
    };
    found = symbols.symbols.some((s) => s.name.includes(testCase.symbol));
  }
  assert(found, `${testCase.language}: project-wide symbol search never found ${testCase.symbol}`);

  // Java is the reason this script exists. Its entry hands jdtls a `-data`
  // directory and deliberately does NOT create it, on the assumption that jdtls
  // creates it itself — an assumption no test could make until one started a
  // real server. If it were wrong, jdtls would have refused to start and every
  // assertion above would already have failed; this checks the directory is
  // where we said it would be rather than somewhere jdtls chose.
  if (testCase.language === "java") {
    const dataDir = jdtlsDataDir(workspace);
    assert(existsSync(dataDir), `jdtls did not create its own -data directory at ${dataDir}`);
  }
}

const required = new Set(
  (process.env.SEEKFORGE_REQUIRE_LSP_SMOKE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const ran: string[] = [];
const workspaces: string[] = [];

try {
  for (const testCase of CASES) {
    const workspace = makeWorkspace(testCase.files);
    workspaces.push(workspace);
    testCase.prepare?.(workspace);
    if (!serverOnPath(join(workspace, testCase.use.path))) {
      if (required.has(testCase.language)) {
        throw new Error(`${testCase.language} is required for this run but no language server for it is on PATH.`);
      }
      console.log(`SKIP ${testCase.language}: no language server on PATH.`);
      continue;
    }
    await exercise(testCase, workspace);
    ran.push(testCase.language);
    console.log(`OK   ${testCase.language}`);
  }

  const missing = [...required].filter((language) => !ran.includes(language));
  if (missing.length > 0) throw new Error(`required languages never ran: ${missing.join(", ")}`);
  if (ran.length === 0) {
    console.log("SKIP: no language server on PATH — install typescript-language-server to run this smoke.");
  } else {
    console.log(`LSP tools smoke passed (${ran.join(", ")})`);
  }
} finally {
  await disposeLspServers();
  for (const workspace of workspaces) rmSync(workspace, { recursive: true, force: true });
}
