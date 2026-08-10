import { createRequire } from "node:module";
import * as path from "node:path";
import { OUTLINE_PREFIX, symbolBackends, type SymbolBackend } from "./repo-map.js";

/**
 * Optional tree-sitter (AST) symbol backend. Prepended ahead of the regex floor
 * by ensureAstBackend(); if web-tree-sitter or its grammars are missing or
 * incompatible, it fails quietly and regex stays in charge. AST parsing is
 * accurate and comment/string-aware (regex is not).
 *
 * web-tree-sitter init/grammar-load is async, but parser.parse() is sync — so we
 * load everything once up front and keep the backend methods synchronous to fit
 * the (sync) resolver in repo-map.ts.
 */

// File extension -> tree-sitter-wasms grammar name.
//
// tree-sitter-wasms ships 36 grammars; this maps the ones whose declaration
// node types are known and tested (see repo-map-ast.test.ts). Deliberately NOT
// mapped, with reasons, so nobody re-derives them:
//
//   vue     — the <script> body arrives as one `raw_text` token. Handled
//             WITHOUT this grammar instead: see EMBEDDED_SCRIPT_EXTS below,
//             which lifts the script out and parses it as JS/TS.
//   dart, elm, ql — the shipped .wasm fails to load. Re-measured against
//             tree-sitter-wasms 0.1.13: the runtime accepts language versions
//             13-14 and these are built at 15, 12 and 10. Nothing here can fix
//             that; it needs different grammar builds upstream.
//   objc (23MB), ocaml (15MB), tlaplus (15MB) — heavy for their likelihood.
//   elixir IS mapped now: everything parses to `call`, so it needs its own name
//             rule rather than a node-type match — see elixirDefinitionName.
//   json/yaml/toml/html/css — no declarations to outline.
const GRAMMARS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  java: "java",
  rs: "rust",
  go: "go",
  c: "c",
  h: "cpp", // .h is ambiguous; cpp grammar is a superset that parses C too
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "c_sharp",
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  scala: "scala",
  sc: "scala",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  lua: "lua",
  zig: "zig",
  sol: "solidity",
  ex: "elixir",
  exs: "elixir",
};

/**
 * Loaded when a caller gives no hint about what it is about to parse.
 *
 * These are exactly the grammars this module used to load unconditionally, so
 * a hint-less call behaves as it always did. What changed is that every caller
 * in the repository now hints, and hinting is what makes the new languages
 * affordable: all 36 shipped grammars cost 1031ms and 454MB of RSS (measured),
 * and even the original ten cost 48MB for a workspace that may be entirely
 * Python. A TypeScript repo now loads two grammars where it used to load ten.
 */
const DEFAULT_EXTENSIONS = ["js", "ts", "tsx", "py", "java", "rs", "go", "c", "cpp", "cs"];

// Named-declaration node types across the supported grammars (JS/TS, Python,
// Java, Rust, Go, C/C++, C#). They only match within the relevant grammar's
// tree, so a shared set is safe. find_definition recurses, so wrapper-nested
// types (Go type_spec/const_spec, etc.) are still reached.
const DEFINITION_TYPES = new Set([
  // JS / TS
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "variable_declarator",
  // Python
  "function_definition",
  "class_definition",
  // Java / C#
  "method_declaration",
  "constructor_declaration",
  "record_declaration",
  "namespace_declaration",
  "struct_declaration",
  "delegate_declaration",
  // Rust
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "mod_item",
  "type_item",
  "const_item",
  "static_item",
  "union_item",
  "macro_definition",
  // Go
  "type_spec",
  "const_spec",
  "var_spec",
  // C / C++
  "struct_specifier",
  "union_specifier",
  "enum_specifier",
  "class_specifier",
  "namespace_definition",
  "type_definition",
  // Ruby — `class`/`module`/`method` really are the node type names here.
  //
  // `class` is also JavaScript's node type for a class EXPRESSION, so adding it
  // widens JS/TS slightly: `const A = class Named {}` keeps outlining as `A`
  // (the outline reads top-level nodes, and the expression is nested inside the
  // declarator), but find_definition — which recurses — can now find `Named`.
  // That is a gap closing, not a behavior change to something that worked, and
  // it is pinned by a test so it stays deliberate.
  "class",
  "module",
  "method",
  "singleton_method",
  // PHP (function_definition/interface_declaration/enum_declaration are shared
  // with the sets above; these are the ones PHP adds).
  "trait_declaration",
  // Swift — struct and enum both parse as class_declaration in this grammar;
  // protocol_declaration and init_declaration are its own.
  "protocol_declaration",
  "init_declaration",
  // Kotlin. `property_declaration` is C#'s node type too, so a C# property
  // becomes findable by name for the same reason as the class expression above
  // — nested, so the outline is unchanged; reachable, so find_definition sees
  // it. Also pinned by a test.
  "object_declaration",
  "property_declaration",
  // Scala
  "trait_definition",
  "object_definition",
  "class_definition",
  // Lua
  "function_definition_statement",
  "local_function_definition_statement",
  // Zig gets `function_declaration` from the JS/Kotlin/Swift line above. Its
  // `const Foo = struct {…}` is a plain variable_declaration, which is NOT
  // listed here on purpose: JavaScript uses that same node type, and the
  // variable_declarator branch in outline() below is what handles it there.
  // Solidity
  "contract_declaration",
  "library_declaration",
  "state_variable_declaration",
]);

// web-tree-sitter is optional; keep the boundary structural so importing this
// module never makes its runtime package mandatory.
type TsNode = {
  type: string;
  text: string;
  namedChildCount: number;
  namedChild(index: number): TsNode;
  childForFieldName?(name: string): TsNode | null;
  startPosition: { row: number };
  startIndex: number;
  endIndex: number;
};
type TsTree = { rootNode: TsNode; delete(): void };
type TsParser = { parse(input: string): TsTree };
type TsLanguage = { load(path: string): Promise<unknown> };
type TsParserConstructor = {
  new (): TsParser & { setLanguage(language: unknown): void };
  init(options: { locateFile(name: string): string }): Promise<void>;
  Language?: TsLanguage;
};
type TsModule = { default?: TsParserConstructor; Parser?: TsParserConstructor; Language?: TsLanguage };

const parsers = new Map<string, TsParser>(); // grammar name -> parser with language set
let state: "idle" | "ready" | "failed" = "idle";
let initPromise: Promise<boolean> | undefined;

function extOf(rel: string): string {
  return rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
}

const DECLARATOR_NAME_TYPES = new Set(["identifier", "field_identifier", "type_identifier", "qualified_identifier"]);

/** Node types that ARE a name when a grammar exposes no `name` field. */
const BARE_NAME_TYPES = new Set(["type_identifier", "simple_identifier"]);

function nameOf(node: TsNode): string | undefined {
  // Most grammars expose the name directly.
  const direct = node.childForFieldName?.("name");
  if (direct) return direct.text as string;
  // C/C++ nest the name inside a declarator chain (function_definition ->
  // function_declarator -> identifier); follow `declarator` fields to it.
  let d: TsNode | null | undefined = node.childForFieldName?.("declarator");
  for (let guard = 0; d && guard < 12; guard++) {
    if (DECLARATOR_NAME_TYPES.has(d.type)) return d.text as string;
    d = d.childForFieldName?.("declarator");
  }
  // Kotlin marks no `name` field at all: a class is `class_declaration` whose
  // first named child is a bare `type_identifier`, a function's is a
  // `simple_identifier`. Searching direct children only, and only for those two
  // types, keeps this from inventing names for the grammars handled above —
  // they never reach here.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (BARE_NAME_TYPES.has(child.type)) return child.text as string;
    // …and a Kotlin `val x = 1` puts it one level further down, inside a
    // `variable_declaration` wrapper.
    if (child.type === "variable_declaration") {
      for (let j = 0; j < child.namedChildCount; j++) {
        const inner = child.namedChild(j);
        if (BARE_NAME_TYPES.has(inner.type)) return inner.text as string;
      }
    }
  }
  return undefined;
}

/** Elixir needs its own name rule everywhere a declaration is looked for. */
function isElixir(rel: string): boolean {
  return GRAMMARS[extOf(rel)] === "elixir";
}

function parserFor(rel: string): TsParser | undefined {
  const g = GRAMMARS[extOf(rel)];
  return g ? parsers.get(g) : undefined;
}

// ---------------------------------------------------------------------------
// Single-file components: the code lives in a <script> block inside markup.
// ---------------------------------------------------------------------------

/**
 * Extensions whose file is markup wrapping one or more script blocks.
 *
 * The vue grammar was deliberately unmapped because it hands the whole script
 * body over as one `raw_text` token — an AST that knows less than the regex
 * floor. Rather than parse the markup at all, these files are handled by
 * lifting the script out and parsing THAT with the JS/TS grammar it declares,
 * which is the grammar that actually understands the code. Svelte comes along
 * for free: no svelte grammar is involved either.
 */
const EMBEDDED_SCRIPT_EXTS = new Set(["vue", "svelte"]);

type EmbeddedScript = { code: string; grammar: string; lineOffset: number };

/**
 * `lang="…"` on the tag decides the grammar; unset means JavaScript.
 *
 * Only two grammars are named, so only two are ever loaded for a component
 * repository. A `lang="tsx"` — which Vue and Svelte both allow and almost
 * nobody writes — reads as TypeScript: its declarations parse, and the JSX it
 * may contain degrades to a partial outline rather than to nothing.
 */
function scriptGrammar(attributes: string): string {
  const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(attributes)?.[1]?.toLowerCase();
  return lang === "ts" || lang === "typescript" || lang === "tsx" ? "typescript" : "javascript";
}

/**
 * Every `<script>` block in a single-file component, with the line it starts on.
 *
 * A Vue file routinely has two (`<script setup>` beside a plain `<script>`), and
 * both hold declarations worth outlining. The offset is what keeps
 * find_definition honest: the parse is of the script alone, but every line
 * number it reports has to point into the real file.
 */
export function embeddedScripts(content: string): EmbeddedScript[] {
  const out: EmbeddedScript[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const attributes = m[1] ?? "";
    const code = m[2] ?? "";
    // The body starts right after the opening tag. Measured from the tag's own
    // parts rather than by subtracting the closing tag's length, which would be
    // wrong the moment someone writes `</script >`.
    const bodyStart = m.index + "<script".length + attributes.length + 1;
    const lineOffset = content.slice(0, bodyStart).split("\n").length - 1;
    out.push({ code, grammar: scriptGrammar(attributes), lineOffset });
  }
  return out;
}

/** The parsed script blocks of a single-file component, or undefined if it is not one. */
function embeddedTrees(rel: string, content: string): { script: EmbeddedScript; parser: TsParser }[] | undefined {
  if (!EMBEDDED_SCRIPT_EXTS.has(extOf(rel))) return undefined;
  const out: { script: EmbeddedScript; parser: TsParser }[] = [];
  for (const script of embeddedScripts(content)) {
    // A grammar that was never loaded (nothing hinted at this file) leaves the
    // block to the regex floor rather than reporting an empty component.
    const parser = parsers.get(script.grammar);
    if (parser) out.push({ script, parser });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elixir: declarations are macro calls, not declaration nodes.
// ---------------------------------------------------------------------------

/**
 * The macros that introduce a name. Everything in an Elixir file parses to
 * `call`, so there is no node type to match on — the target identifier is what
 * says whether a call declares something. Measured against the shipped grammar:
 * `call(identifier "def", arguments(call(identifier "name", …)), do_block)`.
 */
const ELIXIR_DEFINERS = new Set([
  "defmodule",
  "defprotocol",
  "defimpl",
  "defstruct",
  "defexception",
  "def",
  "defp",
  "defmacro",
  "defmacrop",
  "defguard",
  "defguardp",
  "defdelegate",
]);

/** The name a `defmodule`/`def`/… call introduces, or undefined if it is not one. */
function elixirDefinitionName(node: TsNode): string | undefined {
  if (node.type !== "call" || node.namedChildCount < 2) return undefined;
  const target = node.namedChild(0);
  if (target.type !== "identifier" || !ELIXIR_DEFINERS.has(target.text)) return undefined;
  const args = node.namedChild(1);
  if (args.type !== "arguments" || args.namedChildCount === 0) {
    // `defstruct` with no arguments still declares the struct; name it after
    // nothing rather than inventing one.
    return undefined;
  }
  let head: TsNode = args.namedChild(0);
  // `def foo(x) when is_integer(x)` wraps the head in the `when` operator.
  for (let guard = 0; head.type === "binary_operator" && head.namedChildCount > 0 && guard < 4; guard++) {
    head = head.namedChild(0);
  }
  // `defmodule Foo` / `def foo` name themselves; `def foo(x)` puts the name in
  // the target of an inner call.
  if (head.type === "alias" || head.type === "identifier") return head.text;
  if (head.type === "call" && head.namedChildCount > 0) {
    const inner = head.namedChild(0);
    if (inner.type === "identifier" || inner.type === "alias") return inner.text;
  }
  return undefined;
}

/**
 * Every name an Elixir file declares, module and functions alike.
 *
 * Unlike the other grammars this descends: a module's functions live inside its
 * `do_block`, so a top-level-only scan would outline every file as its one
 * module name. The depth bound keeps a deeply nested macro from walking the
 * whole tree for a listing that shows eight names.
 */
function elixirNames(root: TsNode, depth = 0): string[] {
  if (depth > 4) return [];
  const names: string[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    const name = elixirDefinitionName(child);
    if (name !== undefined) names.push(name);
    names.push(...elixirNames(child, depth + 1));
  }
  return names;
}

/** Top-level declared names in one parsed tree, in source order. */
function outlineNames(root: TsNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < root.namedChildCount; i++) {
    let n: TsNode = root.namedChild(i);
    if (n.type === "export_statement" && n.namedChildCount > 0) n = n.namedChild(0); // unwrap `export ...`
    if (DEFINITION_TYPES.has(n.type)) {
      const nm = nameOf(n);
      if (nm) names.push(nm);
    } else if (n.type === "lexical_declaration" || n.type === "variable_declaration") {
      for (let j = 0; j < n.namedChildCount; j++) {
        const d: TsNode = n.namedChild(j);
        if (d.type === "variable_declarator") {
          const nm = nameOf(d);
          if (nm) names.push(nm);
        }
      }
    } else if (n.type === "export_clause") {
      // Barrel re-exports: `export { a, b as c }` -> list the exported names.
      for (let j = 0; j < n.namedChildCount; j++) {
        const spec: TsNode = n.namedChild(j);
        if (spec.type === "export_specifier") {
          const nm = nameOf(spec);
          if (nm) names.push(nm);
        }
      }
    }
  }
  return names;
}

/** Whether a node declares `symbol` under the ordinary type-driven rule. */
function declaresSymbol(node: TsNode, symbol: string): boolean {
  return DEFINITION_TYPES.has(node.type) && nameOf(node) === symbol;
}

/**
 * Whether an Elixir macro call declares `symbol`.
 *
 * A module's real name is dotted (`MyApp.Accounts`) and the outline says so,
 * but find_definition only accepts identifier-shaped symbols — by design, so a
 * lookup cannot smuggle in whitespace or punctuation. Matching the last segment
 * as well is what lets someone search for `Accounts` and find the module the
 * outline named, without widening that gate.
 */
function elixirDeclaresSymbol(node: TsNode, symbol: string): boolean {
  const name = elixirDefinitionName(node);
  if (name === undefined) return false;
  return name === symbol || name.slice(name.lastIndexOf(".") + 1) === symbol;
}

/**
 * Every node named `symbol`, anywhere in one tree, as file rows via `rowOffset`.
 *
 * `declares` is what a grammar's declarations look like. All but one answer by
 * node type; Elixir has no declaration node types at all and answers by which
 * macro is being called.
 */
function definitionRows(
  root: TsNode,
  symbol: string,
  lines: string[],
  rowOffset: number,
  declares: (node: TsNode, symbol: string) => boolean = declaresSymbol,
): DefinitionRow[] {
  const out: DefinitionRow[] = [];
  const visit = (node: TsNode): void => {
    if (declares(node, symbol)) {
      const row = (node.startPosition.row as number) + rowOffset;
      out.push({ line: row + 1, text: (lines[row] ?? "").trim().slice(0, 200) });
    }
    for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
  };
  visit(root);
  return out;
}

type DefinitionRow = { line: number; text: string };

const astBackend: SymbolBackend = {
  name: "tree-sitter",
  outline(rel, content) {
    const embedded = embeddedTrees(rel, content);
    if (embedded) {
      if (embedded.length === 0) return undefined; // no parseable script -> regex floor
      const names: string[] = [];
      for (const { script, parser } of embedded) {
        let tree: TsTree | undefined;
        try {
          tree = parser.parse(script.code);
          names.push(...outlineNames(tree.rootNode));
        } catch {
          return undefined;
        } finally {
          tree?.delete();
        }
      }
      const uniq = [...new Set(names)].slice(0, 8);
      return uniq.length > 0 ? `${OUTLINE_PREFIX} ${uniq.join(", ")}` : "";
    }
    const parser = parserFor(rel);
    if (!parser) return undefined; // unsupported ext / not loaded -> defer to regex
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(content);
      const names = isElixir(rel) ? elixirNames(tree.rootNode) : outlineNames(tree.rootNode);
      const uniq = [...new Set(names)].slice(0, 8);
      return uniq.length > 0 ? `${OUTLINE_PREFIX} ${uniq.join(", ")}` : "";
    } catch {
      return undefined; // any parse/extraction failure -> defer to the regex floor
    } finally {
      tree?.delete(); // free the WASM-backed tree (results above are plain strings)
    }
  },
  definitions(rel, content, symbol) {
    const lines = content.split("\n");
    const embedded = embeddedTrees(rel, content);
    if (embedded) {
      if (embedded.length === 0) return undefined;
      const out: DefinitionRow[] = [];
      for (const { script, parser } of embedded) {
        let tree: TsTree | undefined;
        try {
          tree = parser.parse(script.code);
          // Rows come from the script's own parse; the offset and the text both
          // come from the real file, so a hit points where a reader can go.
          out.push(...definitionRows(tree.rootNode, symbol, lines, script.lineOffset));
        } catch {
          return undefined;
        } finally {
          tree?.delete();
        }
      }
      return out;
    }
    const parser = parserFor(rel);
    if (!parser) return undefined;
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(content);
      return definitionRows(tree.rootNode, symbol, lines, 0, isElixir(rel) ? elixirDeclaresSymbol : declaresSymbol);
    } catch {
      return undefined; // any parse/extraction failure -> defer to the regex floor
    } finally {
      tree?.delete(); // free the WASM-backed tree
    }
  },
  ranges(rel, content) {
    // Deliberately not answered for a single-file component: these are byte
    // offsets used to cut a file without splitting a construct, and the script's
    // offsets are into the script, not the file. Returning them shifted would be
    // worse than leaving the caller its own bounds.
    if (EMBEDDED_SCRIPT_EXTS.has(extOf(rel))) return undefined;
    const parser = parserFor(rel);
    if (!parser) return undefined;
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(content);
      const root = tree.rootNode;
      const out: { start: number; end: number }[] = [];
      // Top-level constructs only: cutting on these boundaries never splits a
      // function/class/etc. (their char offsets are plain numbers, safe post-delete).
      for (let i = 0; i < root.namedChildCount; i++) {
        const n: TsNode = root.namedChild(i);
        out.push({ start: n.startIndex as number, end: n.endIndex as number });
      }
      return out;
    } catch {
      return undefined;
    } finally {
      tree?.delete();
    }
  },
};

/** Resolved once the WASM runtime is up; the per-grammar loader needs both. */
type Runtime = { Parser: TsParserConstructor; Language: TsLanguage; wasmsDir: string };

let runtime: Runtime | undefined;
/** Grammars whose load is in flight — two callers must not build two parsers. */
const loading = new Map<string, Promise<void>>();
/** Grammars whose .wasm failed to load; retrying every call would be pointless. */
const unavailable = new Set<string>();

async function initRuntime(): Promise<Runtime | undefined> {
  if (runtime) return runtime;
  if (state === "failed") return undefined;
  if (initPromise) {
    await initPromise;
    return runtime;
  }
  initPromise = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const wtsDir = path.dirname(require.resolve("web-tree-sitter/package.json"));
      const wasmsDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
      const mod = (await import("web-tree-sitter")) as unknown as TsModule;
      const Parser = mod.default ?? mod.Parser;
      if (!Parser) return false;
      await Parser.init({ locateFile: (name: string) => path.join(wtsDir, name) });
      const Language = Parser.Language ?? mod.Language;
      if (!Language) return false;
      runtime = { Parser, Language, wasmsDir };
      return true;
    } catch {
      state = "failed";
      return false;
    }
  })();
  await initPromise;
  return runtime;
}

async function loadGrammar(rt: Runtime, grammar: string): Promise<void> {
  if (parsers.has(grammar) || unavailable.has(grammar)) return;
  const inFlight = loading.get(grammar);
  if (inFlight) return inFlight;
  const load = (async () => {
    try {
      const lang = await rt.Language.load(path.join(rt.wasmsDir, `tree-sitter-${grammar}.wasm`));
      const parser = new rt.Parser();
      parser.setLanguage(lang);
      parsers.set(grammar, parser);
    } catch {
      // A grammar that will not load is remembered as such; the rest still work
      // and the file falls through to the regex floor.
      unavailable.add(grammar);
    } finally {
      loading.delete(grammar);
    }
  })();
  loading.set(grammar, load);
  return load;
}

/**
 * Load web-tree-sitter and the grammars needed for `hints`, then register the
 * AST backend ahead of regex. Returns true once at least one grammar is loaded,
 * false if tree-sitter is unavailable (the regex floor stays). Idempotent, and
 * safe to call before every repo_map/find_definition/read_file use.
 *
 * `hints` are file paths or bare extensions — whatever the caller is about to
 * parse. Only their grammars load, which is the entire point: the shipped
 * grammar set costs 454MB of RSS if loaded whole, and no workspace needs it.
 * A caller with nothing to hint gets {@link DEFAULT_EXTENSIONS}.
 */
export async function ensureAstBackend(hints?: Iterable<string>): Promise<boolean> {
  if (state === "failed") return false;
  const rt = await initRuntime();
  if (!rt) return false;

  const wanted = new Set<string>();
  for (const hint of hints ?? DEFAULT_EXTENSIONS) {
    const ext = extOf(hint);
    const grammar = GRAMMARS[ext];
    if (grammar !== undefined) wanted.add(grammar);
    // A single-file component needs the grammars its <script> might declare,
    // not one for its own extension — and which one it declares is inside the
    // file, which is not open yet. Both are small next to the markup grammar
    // this replaces.
    if (EMBEDDED_SCRIPT_EXTS.has(ext)) {
      wanted.add("javascript");
      wanted.add("typescript");
    }
  }
  await Promise.all([...wanted].map((grammar) => loadGrammar(rt, grammar)));

  if (parsers.size === 0) {
    // Nothing usable loaded. Not "failed": a later call naming a different
    // language may still succeed, and the regex floor covers this one.
    return false;
  }
  if (state !== "ready") {
    symbolBackends.unshift(astBackend); // ahead of regex, exactly once
    state = "ready";
  }
  return true;
}

/** Test seam: forget the runtime, every loaded grammar, and the backend. */
export function resetAstBackendForTests(): void {
  const at = symbolBackends.indexOf(astBackend);
  if (at >= 0) symbolBackends.splice(at, 1);
  parsers.clear();
  loading.clear();
  unavailable.clear();
  runtime = undefined;
  initPromise = undefined;
  state = "idle";
}

/** Grammar names currently loaded — the measurement surface for the cost above. */
export function loadedAstGrammars(): string[] {
  return [...parsers.keys()].sort();
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Whether the AST backend COULD load, without loading it.
 *
 * Resolved from this module on purpose: web-tree-sitter and tree-sitter-wasms
 * are dependencies of @seekforge/core, so asking from @seekforge/shared (which
 * does not depend on them) answers "missing" on a perfectly good installation.
 * That is a diagnostic reporting a fault that does not exist, which is worse
 * than not checking.
 */
export function astBackendInstalled(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("web-tree-sitter/package.json");
    require.resolve("tree-sitter-wasms/package.json");
    return true;
  } catch {
    return false;
  }
}
