import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * Isolate the GLOBAL memory path from the developer's real ~/.seekforge.
 * search_memory reads ~/.seekforge/memory/project.md via seekforgeHome(), which
 * honors SEEKFORGE_HOME.
 */
const SEEKFORGE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-home-"));
process.env.SEEKFORGE_HOME = SEEKFORGE_HOME;

function writeProjectMemory(workspace: string, content: string): void {
  const file = path.join(workspace, ".seekforge", "memory", "project.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeSubdirMemory(workspace: string, relDir: string, content: string): void {
  const file = path.join(workspace, relDir, ".seekforge", "memory", "project.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function writeGlobalMemory(content: string): void {
  const file = path.join(SEEKFORGE_HOME, ".seekforge", "memory", "project.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function clearGlobalMemory(): void {
  try {
    fs.rmSync(path.join(SEEKFORGE_HOME, ".seekforge", "memory", "project.md"), { force: true });
  } catch {
    /* ignore */
  }
}

const dispatcher = createDefaultDispatcher();

async function search(workspace: string, query: string): Promise<string> {
  const ctx = makeCtx(workspace);
  const res = await dispatcher.execute(call("search_memory", { query }), ctx);
  expect(res.ok).toBe(true);
  return (res.data as { text: string }).text;
}

describe("search_memory tool", () => {
  afterEach(() => clearGlobalMemory());

  it("returns the facts most relevant to a query", async () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      [
        "# Project Memory",
        "- [command] run tests with pnpm vitest run",
        "- [convention] components live under src/ui",
        "- [tech] uses zod for validation",
      ].join("\n"),
    );
    const text = await search(ws, "how do I run the tests here");
    expect(text).toContain("run tests with pnpm vitest run");
    // The top, query-matching fact ranks above unrelated ones.
    const lines = text.split("\n");
    const testIdx = lines.findIndex((l) => l.includes("run tests"));
    const zodIdx = lines.findIndex((l) => l.includes("uses zod"));
    expect(testIdx).toBeGreaterThan(0);
    // zod fact has no query overlap so it's filtered out entirely.
    expect(zodIdx).toBe(-1);
  });

  it("merges project + global + subdir memory, tagged by source", async () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "- [convention] project deploy uses the deploy script");
    writeGlobalMemory("- [convention] global deploy policy: deploy on green CI only");
    writeSubdirMemory(ws, "packages/api", "- [command] deploy the api with make deploy-api");

    const text = await search(ws, "deploy");
    expect(text).toContain("(project)");
    expect(text).toContain("(global)");
    expect(text).toContain("(subdir:packages/api)");
  });

  it("handles empty/missing memory without throwing", async () => {
    const ws = makeWorkspace(); // no memory files at all
    const text = await search(ws, "anything");
    expect(text.toLowerCase()).toContain("no project memory");
  });

  it("reports no match clearly when nothing is relevant", async () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "- [tech] uses vitest for tests");
    const text = await search(ws, "kubernetes ingress configuration");
    expect(text.toLowerCase()).toContain("no matching memory");
  });

  it("an empty query returns always-include (command/tech) facts", async () => {
    const ws = makeWorkspace();
    writeProjectMemory(
      ws,
      ["- [command] build with pnpm build", "- [convention] PRs need two reviewers"].join("\n"),
    );
    const text = await search(ws, "   ");
    expect(text).toContain("build with pnpm build");
  });

  it("is registered as a read-only tool (allowed in ask mode)", async () => {
    const ws = makeWorkspace();
    writeProjectMemory(ws, "- [command] run tests with pnpm test");
    const ctx = makeCtx(ws, { policy: { mode: "ask", approvalMode: "manual" } });
    const res = await dispatcher.execute(call("search_memory", { query: "tests" }), ctx);
    expect(res.ok).toBe(true);
    expect(res.meta?.permission).toBe("readonly");
    expect((res.data as { text: string }).text).toContain("run tests with pnpm test");
  });

  it("is advertised to the model", () => {
    const names = dispatcher.list().map((d) => d.name);
    expect(names).toContain("search_memory");
  });
});
