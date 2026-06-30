import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildRelevantFiles,
  buildRepoMap,
  buildRepoOverview,
  extractSymbols,
  findDefinitions,
  symbolBackends,
  type SymbolBackend,
} from "../../src/agent/repo-map.js";

describe("pluggable symbol backends (tree-sitter seam)", () => {
  it("a prepended backend overrides regex, and undefined falls through to regex", () => {
    const fake: SymbolBackend = {
      name: "fake-ast",
      outline: (rel) => (rel.endsWith(".vue") ? "[ast component]" : undefined),
      definitions: (rel) => (rel.endsWith(".vue") ? [{ line: 1, text: "ast def" }] : undefined),
    };
    symbolBackends.unshift(fake);
    try {
      // .vue: the prepended backend handles it
      expect(extractSymbols("X.vue", "<template/>")).toBe("[ast component]");
      // .js: fake defers (undefined) -> regex floor still works
      expect(extractSymbols("a.js", "export const x = 1;")).toContain("x");
    } finally {
      symbolBackends.shift();
    }
    // restored: regex behaviour is back
    expect(extractSymbols("X.vue", "<template/>\n<script>export default { name: 'X' }</script>")).toContain("[vue");
  });
});

describe("extractSymbols", () => {
  it("pulls exported names from a JS module", () => {
    const s = extractSymbols("a.js", "export function foo(){}\nexport const bar = 1;\nfunction priv(){}");
    expect(s).toContain("foo");
    expect(s).toContain("bar");
    expect(s).not.toContain("priv");
  });

  it("reads module.exports object shorthand", () => {
    expect(extractSymbols("b.js", "function a(){} function b(){}\nmodule.exports = { a, b };")).toContain("a, b");
  });

  it("names a Vue component and flags setup", () => {
    const s = extractSymbols("C.vue", "<template></template>\n<script setup>\nconst name = { name: 'Widget' };\n</script>");
    expect(s).toContain("[vue");
    expect(s).toContain("setup");
  });
});

describe("buildRepoMap", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "repomap-"));
    mkdirSync(join(root, "src/api"), { recursive: true });
    mkdirSync(join(root, "src/views"), { recursive: true });
    mkdirSync(join(root, "node_modules/x"), { recursive: true });
    writeFileSync(join(root, "src/api/user.js"), "export function login(){}\nexport function logout(){}");
    writeFileSync(join(root, "src/views/Home.vue"), "<template/>\n<script>export default { name: 'Home' }</script>");
    writeFileSync(join(root, "node_modules/x/dep.js"), "export const ignored = 1;");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("summarizes structure with per-directory counts and ignores node_modules", () => {
    const map = buildRepoMap(root);
    expect(map).toContain("2 code files"); // user.js + Home.vue, not the dep
    expect(map).toMatch(/api\/\s+\(1\)/);
    expect(map).toMatch(/views\/\s+\(1\)/);
    expect(map).not.toContain("ignored");
    expect(map).not.toContain("node_modules");
  });

  it("lists files with symbol outlines", () => {
    const map = buildRepoMap(root);
    expect(map).toContain("src/api/user.js");
    expect(map).toContain("login, logout");
    expect(map).toContain("name=Home");
  });

  it("scopes to a subtree via path", () => {
    const map = buildRepoMap(root, { path: "src/api" });
    expect(map).toContain("src/api/user.js");
    expect(map).not.toContain("Home.vue");
  });

  it("budgets the file list with maxFiles and notes the remainder", () => {
    const map = buildRepoMap(root, { maxFiles: 1 });
    expect(map).toContain("1 more files");
  });

  it("buildRepoOverview returns undefined for small repos, a map for large ones", () => {
    expect(buildRepoOverview(root)).toBeUndefined(); // 2 files < default threshold
    expect(buildRepoOverview(root, 1)).toContain("# Repo map");
  });

  it("refuses to escape the workspace root via a traversal path", () => {
    expect(buildRepoMap(root, { path: ".." })).toContain("outside the workspace");
    expect(buildRepoMap(root, { path: "../../etc" })).toContain("outside the workspace");
    expect(findDefinitions(root, "login", { path: ".." })).toEqual([]);
    // a normal subtree still works
    expect(buildRepoMap(root, { path: "src/api" })).toContain("src/api/user.js");
  });

  it("findDefinitions locates a declaration and ignores non-identifiers", () => {
    const defs = findDefinitions(root, "login");
    expect(defs).toHaveLength(1);
    expect(defs[0]!.file).toBe("src/api/user.js");
    expect(defs[0]!.line).toBe(1);
    expect(findDefinitions(root, "a.*b")).toEqual([]); // regex metachars rejected
    expect(findDefinitions(root, "nonexistentThing")).toEqual([]);
  });
});

describe("buildRelevantFiles", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "relevant-"));
    mkdirSync(join(root, "src/auth"), { recursive: true });
    mkdirSync(join(root, "src/billing"), { recursive: true });
    mkdirSync(join(root, "src/util"), { recursive: true });
    // A login site whose RELEVANCE is in its path/exports.
    writeFileSync(join(root, "src/auth/login.ts"), "export function login(){}\nexport function logout(){}");
    writeFileSync(join(root, "src/auth/session.ts"), "export function refreshSession(){}");
    writeFileSync(join(root, "src/billing/invoice.ts"), "export function createInvoice(){}");
    // Bulk noise so the tree clears minRepoFiles for the default path.
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(root, `src/util/u${i}.ts`), `export const helper${i} = ${i};`);
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("surfaces the file whose path matches the task, with its outline", () => {
    const out = buildRelevantFiles(root, "fix the login bug")!;
    expect(out).toContain("# Task-relevant files");
    expect(out).toContain("src/auth/login.ts");
    expect(out).toContain("login, logout"); // outline included
    expect(out).not.toContain("invoice.ts"); // unrelated
    expect(out).not.toContain("util/u0.ts"); // generic noise excluded
  });

  it("ranks a path-token hit highest", () => {
    const out = buildRelevantFiles(root, "update src/billing/invoice.ts totals")!;
    // The path-token match must appear before any weaker keyword match.
    expect(out.indexOf("invoice.ts")).toBeGreaterThan(-1);
    const firstFileLine = out.split("\n")[1]!;
    expect(firstFileLine).toContain("invoice.ts");
  });

  it("matches a path-token on component boundaries, not as a bare substring", () => {
    // "index.ts" must hit src/util/index.ts but NOT src/util/reindex.ts.
    writeFileSync(join(root, "src/util/index.ts"), "export function buildIndex(){}");
    writeFileSync(join(root, "src/util/reindex.ts"), "export function reindexAll(){}");
    const out = buildRelevantFiles(root, "refactor index.ts")!;
    expect(out).toContain("src/util/index.ts");
    expect(out).not.toContain("reindex.ts"); // boundary-aware: no spurious match
  });

  it("returns undefined for a generic task (no specific terms)", () => {
    expect(buildRelevantFiles(root, "make it better")).toBeUndefined();
  });

  it("returns undefined for a small tree (navigable directly)", () => {
    const small = mkdtempSync(join(tmpdir(), "relevant-small-"));
    try {
      writeFileSync(join(small, "login.ts"), "export function login(){}");
      expect(buildRelevantFiles(small, "fix login")).toBeUndefined();
    } finally {
      rmSync(small, { recursive: true, force: true });
    }
  });

  it("returns undefined when nothing clears the relevance floor", () => {
    // A keyword that only substring-matches a few paths weakly stays below floor.
    expect(buildRelevantFiles(root, "xyzzy nonexistent feature")).toBeUndefined();
  });
});
