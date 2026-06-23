import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

  it("findDefinitions locates a declaration and ignores non-identifiers", () => {
    const defs = findDefinitions(root, "login");
    expect(defs).toHaveLength(1);
    expect(defs[0]!.file).toBe("src/api/user.js");
    expect(defs[0]!.line).toBe(1);
    expect(findDefinitions(root, "a.*b")).toEqual([]); // regex metachars rejected
    expect(findDefinitions(root, "nonexistentThing")).toEqual([]);
  });
});
