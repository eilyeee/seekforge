import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAstBackend, loadedAstGrammars, resetAstBackendForTests } from "../../src/agent/repo-map-ast.js";
import { declRanges, extractSymbols, findDefinitions, OUTLINE_PREFIX } from "../../src/agent/repo-map.js";

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
      writeFileSync(
        join(d, "a.ts"),
        "// function foo lives only in this comment\nfunction realFoo() {}\ninterface Thing {}",
      );
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

  it.skipIf(!astReady)("reports top-level construct ranges for code-aware truncation", () => {
    const src = "import x from 'y';\nfunction a() {\n  return 1;\n}\nclass B {}\n";
    const ranges = declRanges("m.ts", src);
    expect(ranges).toBeDefined();
    expect(ranges!.length).toBe(3); // import, function, class
    for (const r of ranges!) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeGreaterThan(r.start);
      expect(r.end).toBeLessThanOrEqual(src.length);
    }
  });

  it.skipIf(!astReady)("outlines re-exports from a barrel/index file", () => {
    const o = extractSymbols("index.ts", "export { a, b as c } from './x';\nexport { d };\nexport function e() {}");
    expect(o).toContain("a");
    expect(o).toContain("b");
    expect(o).toContain("d");
    expect(o).toContain("e");
  });

  it.skipIf(!astReady)("handles unicode identifiers and safely rejects non-identifier input", () => {
    const d = mkdtempSync(join(tmpdir(), "ast-uni-"));
    try {
      writeFileSync(join(d, "u.ts"), "function 你好() {}\nexport const café = 1;\nfunction $util() {}");
      expect(findDefinitions(d, "你好")).toHaveLength(1);
      expect(findDefinitions(d, "café")).toHaveLength(1);
      expect(findDefinitions(d, "$util")).toHaveLength(1); // `$` must not crash the regex floor
      expect(findDefinitions(d, "a.*b")).toEqual([]); // regex metachars rejected, no throw
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
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
        ["Foo", 1],
        ["bar", 1],
        ["baz", 1],
        ["Qux", 1],
        ["Hello", 1],
        ["Tee", 1],
        ["add", 1],
        ["Pt", 1],
        ["Widget", 1],
        ["main", 1],
        ["Svc", 1],
        ["Doit", 1],
      ] as const) {
        expect(findDefinitions(d, sym), `definition of ${sym}`).toHaveLength(n);
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  /**
   * The nine languages whose grammars shipped in tree-sitter-wasms all along
   * and were never wired up. Before this, PHP and Kotlin outlined to the EMPTY
   * STRING and Ruby reported its methods while missing the enclosing class —
   * measured, not hypothetical. Each case asserts the outline AND one
   * find_definition, because the two walk the tree differently.
   */
  const LANGUAGES: { file: string; source: string; defines: string[]; find: string }[] = [
    {
      file: "a.rb",
      source: "class Foo\n  def bar(x)\n  end\n  def self.baz\n  end\nend\nmodule M; end\n",
      defines: ["Foo", "M"],
      find: "bar",
    },
    {
      file: "a.php",
      source:
        "<?php\ninterface I {}\ntrait T {}\nclass Foo implements I {\n  public function bar($x) {}\n}\nfunction top() {}\n",
      defines: ["I", "T", "Foo", "top"],
      find: "bar",
    },
    {
      file: "a.kt",
      source: "interface I\nobject O\ndata class Foo(val x: Int) {\n  fun bar(x: Int) {}\n}\nfun top() {}\nval v = 1\n",
      defines: ["I", "O", "Foo", "top", "v"],
      find: "bar",
    },
    {
      file: "a.swift",
      source: "protocol P {}\nstruct S: P { func bar(x: Int) {} }\nclass Foo { init() {} }\nfunc top() {}\n",
      defines: ["P", "S", "Foo", "top"],
      find: "bar",
    },
    {
      file: "a.scala",
      source: "trait T\nobject O\ncase class Foo(x: Int)\nclass C\n",
      defines: ["T", "O", "Foo", "C"],
      find: "Foo",
    },
    {
      file: "a.sh",
      source: "function foo() {\n  echo hi\n}\nbar() {\n  echo hi\n}\n",
      defines: ["foo", "bar"],
      find: "bar",
    },
    {
      file: "a.lua",
      source: "function M.foo(x)\nend\nlocal function bar()\nend\n",
      defines: ["M.foo", "bar"],
      find: "bar",
    },
    {
      file: "a.zig",
      source: "pub fn top() void {}\npub fn other() void {}\n",
      defines: ["top", "other"],
      find: "other",
    },
    {
      file: "a.sol",
      source: "contract Foo {\n  function bar(uint x) public {}\n}\ninterface I {}\n",
      defines: ["Foo", "I"],
      find: "bar",
    },
  ];

  it("outlines the nine languages whose grammars shipped but were never wired", async () => {
    const ready = await ensureAstBackend(LANGUAGES.map((l) => l.file));
    if (!ready) return; // tree-sitter unavailable here; the regex floor is tested elsewhere
    for (const lang of LANGUAGES) {
      // A directory per language: several of them define a `bar`, and
      // find_definition searches a whole tree.
      const d = mkdtempSync(join(tmpdir(), "ast-more-"));
      try {
        writeFileSync(join(d, lang.file), lang.source);
        expect(extractSymbols(lang.file, lang.source), lang.file).toBe(`${OUTLINE_PREFIX} ${lang.defines.join(", ")}`);
        expect(findDefinitions(d, lang.find), `${lang.file}:${lang.find}`).toHaveLength(1);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  // 60s, not the suite's 30s: this is the one test that RESETS the WASM runtime
  // and reloads grammars from disk, which is ~10s of real work on its own. Under
  // a full-suite run the machine is saturated and it crossed the default — a
  // durable test, not a flaky one.
  it("loads only the grammars it was asked for", { timeout: 60_000 }, async () => {
    resetAstBackendForTests();
    try {
      // The point of the hint. Loading all 36 shipped grammars costs 454MB of
      // RSS; a Ruby workspace has no reason to hold the Kotlin parser, and
      // before the hint every caller paid for ten regardless of the language.
      if (!(await ensureAstBackend(["main.rb", "lib/util.rb"]))) return;
      expect(loadedAstGrammars()).toEqual(["ruby"]);
      // A second call adds to the set rather than replacing it.
      await ensureAstBackend(["app.php"]);
      expect(loadedAstGrammars()).toEqual(["php", "ruby"]);
      // An extension with no grammar is not an error, and loads nothing.
      await ensureAstBackend(["notes.txt", "data.csv"]);
      expect(loadedAstGrammars()).toEqual(["php", "ruby"]);
    } finally {
      resetAstBackendForTests();
      await ensureAstBackend();
    }
  });

  it("gives concurrent callers of one grammar a single parser", async () => {
    resetAstBackendForTests();
    try {
      // Loading is async, so a check-then-act would let two callers each build
      // a parser for the same grammar — one of them then orphaned in WASM
      // memory, which is the expensive thing here.
      const results = await Promise.all([
        ensureAstBackend(["a.rb"]),
        ensureAstBackend(["b.rb"]),
        ensureAstBackend(["c.rb"]),
      ]);
      if (!results[0]) return;
      expect(loadedAstGrammars()).toEqual(["ruby"]);
    } finally {
      resetAstBackendForTests();
      await ensureAstBackend();
    }
  });

  it("widens the already-supported languages without changing their outlines", async () => {
    // Several node types added for Ruby and Kotlin are shared with grammars
    // that were already wired: `class` is JavaScript's class EXPRESSION and
    // `property_declaration` is C#'s property. Both are nested rather than
    // top-level, so the OUTLINE is untouched — but find_definition recurses, so
    // they become findable. Asserted in both directions so the widening stays a
    // decision rather than a surprise.
    if (!(await ensureAstBackend(["a.ts", "a.cs", "a.js"]))) return;
    const d = mkdtempSync(join(tmpdir(), "ast-widen-"));
    try {
      const ts = "const A = class Named {};\nexport class Real {}\n";
      const cs = "class Svc {\n  public int Count { get; set; }\n  void Doit() {}\n}\n";
      const js = "var x = 1;\nlet y = 2;\nconst z = 3;\nclass C {}\n";
      writeFileSync(join(d, "a.ts"), ts);
      writeFileSync(join(d, "a.cs"), cs);
      writeFileSync(join(d, "a.js"), js);

      // Unchanged: the class expression outlines under the name it is bound to,
      // the C# property does not reach the top level, and JS var/let/const
      // still come through the variable_declarator branch.
      expect(extractSymbols("a.ts", ts)).toBe(`${OUTLINE_PREFIX} A, Real`);
      expect(extractSymbols("a.cs", cs)).toBe(`${OUTLINE_PREFIX} Svc`);
      expect(extractSymbols("a.js", js)).toBe(`${OUTLINE_PREFIX} x, y, z, C`);

      // Newly reachable.
      expect(findDefinitions(d, "Named")).toHaveLength(1);
      expect(findDefinitions(d, "Count")).toHaveLength(1);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("single-file components and Elixir", () => {
  const VUE = `<template>
  <button @click="submit">go</button>
</template>

<script setup lang="ts">
interface Props { id: string }
function submit(): void {}
const label = "go";
</script>
`;

  it("outlines a Vue component's script and points at its real line", async () => {
    // No vue grammar is involved: it hands the script over as one raw_text
    // token, so the script is lifted out and parsed as the TypeScript it says
    // it is. The line number has to survive that detour.
    const ready = await ensureAstBackend(["App.vue"]);
    if (!ready) return;
    expect(extractSymbols("App.vue", VUE)).toBe(`${OUTLINE_PREFIX} Props, submit, label`);

    const d = mkdtempSync(join(tmpdir(), "ast-vue-"));
    try {
      writeFileSync(join(d, "App.vue"), VUE);
      const hits = findDefinitions(d, "submit");
      expect(hits).toHaveLength(1);
      // `function submit` is on line 7 of the FILE, not line 3 of the script.
      expect(hits[0]?.line).toBe(7);
      expect(hits[0]?.text).toContain("function submit");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("reads both script blocks of a Vue component", async () => {
    const ready = await ensureAstBackend(["App.vue"]);
    if (!ready) return;
    const two = `<script>
export const legacy = 1;
</script>

<script setup lang="ts">
function fresh() {}
</script>
`;
    expect(extractSymbols("App.vue", two)).toBe(`${OUTLINE_PREFIX} legacy, fresh`);
  });

  it("outlines a Svelte component through the same path", async () => {
    const ready = await ensureAstBackend(["Card.svelte"]);
    if (!ready) return;
    const svelte = `<script lang="ts">
  export let title: string;
  function toggle() {}
</script>

<h1>{title}</h1>
`;
    expect(extractSymbols("Card.svelte", svelte)).toContain("toggle");
  });

  it("leaves a component with no script to the regex floor", async () => {
    const ready = await ensureAstBackend(["App.vue"]);
    if (!ready) return;
    // undefined from this backend means "defer"; a template-only component
    // must not be reported as a file that defines nothing.
    expect(extractSymbols("App.vue", "<template><p>hi</p></template>\n")).not.toContain(OUTLINE_PREFIX);
  });

  const ELIXIR = `defmodule MyApp.Accounts do
  @moduledoc "docs"

  def create_user(attrs) do
    :ok
  end

  defp normalize(x) when is_binary(x), do: x

  defmacro when_ready(do: block), do: block
end
`;

  it("outlines an Elixir module and the functions inside it", async () => {
    // Every Elixir declaration is a macro CALL, so there is no declaration node
    // type to match: the target identifier is what makes a call a definition,
    // and the functions live one level down inside the module's do_block.
    const ready = await ensureAstBackend(["accounts.ex"]);
    if (!ready) return;
    expect(extractSymbols("accounts.ex", ELIXIR)).toBe(
      `${OUTLINE_PREFIX} MyApp.Accounts, create_user, normalize, when_ready`,
    );
  });

  it("finds an Elixir function past its guard clause", async () => {
    const ready = await ensureAstBackend(["accounts.ex"]);
    if (!ready) return;
    const d = mkdtempSync(join(tmpdir(), "ast-ex-"));
    try {
      writeFileSync(join(d, "accounts.ex"), ELIXIR);
      // `defp normalize(x) when is_binary(x)` wraps the head in a `when`
      // operator; the name is still normalize.
      expect(findDefinitions(d, "normalize")).toHaveLength(1);
      // The outline names the module `MyApp.Accounts`, but find_definition only
      // accepts identifier-shaped symbols — so the last segment is what finds
      // it, and the dotted form is correctly refused rather than half-matched.
      expect(findDefinitions(d, "Accounts")).toHaveLength(1);
      expect(findDefinitions(d, "MyApp.Accounts")).toHaveLength(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
