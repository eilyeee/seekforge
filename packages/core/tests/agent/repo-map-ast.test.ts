import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAstBackend } from "../../src/agent/repo-map-ast.js";
import { extractSymbols, findDefinitions } from "../../src/agent/repo-map.js";

// Optional backend: load it once. If web-tree-sitter / grammars are unavailable
// in this environment, `astReady` is false and the AST-specific cases skip
// (the regex floor is covered by repo-map.test.ts). Vitest isolates this file,
// so registering the AST backend here does not affect the regex-only tests.
const astReady = await ensureAstBackend();

describe("tree-sitter AST backend (optional)", () => {
  it("initializes to a boolean (loaded or cleanly unavailable)", () => {
    expect(typeof astReady).toBe("boolean");
  });

  it.skipIf(!astReady)("ignores a commented-out definition (which regex would false-match)", () => {
    const d = mkdtempSync(join(tmpdir(), "ast-test-"));
    try {
      writeFileSync(join(d, "a.ts"), "// function foo lives only in this comment\nfunction realFoo() {}\ninterface Thing {}");
      expect(findDefinitions(d, "foo")).toHaveLength(0); // AST sees the comment, not a definition
      expect(findDefinitions(d, "realFoo")).toHaveLength(1);
      expect(findDefinitions(d, "Thing")).toHaveLength(1); // TS interface
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it.skipIf(!astReady)("outlines exported declarations", () => {
    const o = extractSymbols("m.ts", "export function alpha() {}\nexport const beta = () => {};\nclass Gamma {}");
    expect(o).toContain("alpha");
    expect(o).toContain("beta");
    expect(o).toContain("Gamma");
  });

  it.skipIf(!astReady)("outlines re-exports from a barrel/index file", () => {
    const o = extractSymbols("index.ts", "export { a, b as c } from './x';\nexport { d };\nexport function e() {}");
    expect(o).toContain("a");
    expect(o).toContain("b");
    expect(o).toContain("d");
    expect(o).toContain("e");
  });

  it.skipIf(!astReady)("finds definitions in java/rust/go/c/c++/c#", () => {
    const d = mkdtempSync(join(tmpdir(), "ast-langs-"));
    try {
      writeFileSync(join(d, "A.java"), "class Foo { void bar() {} }");
      writeFileSync(join(d, "b.rs"), "fn baz() {}\nstruct Qux {}");
      writeFileSync(join(d, "c.go"), "func Hello() {}\ntype Tee struct{}");
      writeFileSync(join(d, "d.c"), "int add(int a){ return a; }\nstruct Pt { int x; };");
      writeFileSync(join(d, "e.cpp"), "class Widget { void run(){} };\nint main(){ return 0; }");
      writeFileSync(join(d, "f.cs"), "class Svc { void Doit() {} }");
      for (const [sym, n] of [
        ["Foo", 1], ["bar", 1], ["baz", 1], ["Qux", 1], ["Hello", 1],
        ["Tee", 1], ["add", 1], ["Pt", 1], ["Widget", 1], ["main", 1], ["Svc", 1], ["Doit", 1],
      ] as const) {
        expect(findDefinitions(d, sym), `definition of ${sym}`).toHaveLength(n);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
