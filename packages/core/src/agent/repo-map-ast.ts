import { createRequire } from "node:module";
import * as path from "node:path";
import { symbolBackends, type SymbolBackend } from "./repo-map.js";

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
};

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
]);

// web-tree-sitter has no bundled types we depend on; treat its nodes structurally.
/* eslint-disable @typescript-eslint/no-explicit-any */
type TsNode = any;
type TsTree = { rootNode: TsNode; delete(): void };
type TsParser = { parse(input: string): TsTree };

const parsers = new Map<string, TsParser>(); // grammar name -> parser with language set
let state: "idle" | "ready" | "failed" = "idle";
let initPromise: Promise<boolean> | undefined;

function extOf(rel: string): string {
  return rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
}

const DECLARATOR_NAME_TYPES = new Set([
  "identifier",
  "field_identifier",
  "type_identifier",
  "qualified_identifier",
]);

function nameOf(node: TsNode): string | undefined {
  // Most grammars expose the name directly.
  const direct = node.childForFieldName?.("name");
  if (direct) return direct.text as string;
  // C/C++ nest the name inside a declarator chain (function_definition ->
  // function_declarator -> identifier); follow `declarator` fields to it.
  let d: TsNode = node.childForFieldName?.("declarator");
  for (let guard = 0; d && guard < 12; guard++) {
    if (DECLARATOR_NAME_TYPES.has(d.type)) return d.text as string;
    d = d.childForFieldName?.("declarator");
  }
  return undefined;
}

function parserFor(rel: string): TsParser | undefined {
  const g = GRAMMARS[extOf(rel)];
  return g ? parsers.get(g) : undefined;
}

const astBackend: SymbolBackend = {
  name: "tree-sitter",
  outline(rel, content) {
    const parser = parserFor(rel);
    if (!parser) return undefined; // unsupported ext / not loaded -> defer to regex
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(content);
      const root = tree.rootNode;
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
      const uniq = [...new Set(names)].slice(0, 8);
      return uniq.length > 0 ? `exports: ${uniq.join(", ")}` : "";
    } catch {
      return undefined; // any parse/extraction failure -> defer to the regex floor
    } finally {
      tree?.delete(); // free the WASM-backed tree (results above are plain strings)
    }
  },
  definitions(rel, content, symbol) {
    const parser = parserFor(rel);
    if (!parser) return undefined;
    let tree: TsTree | undefined;
    try {
      tree = parser.parse(content);
      const lines = content.split("\n");
      const out: { line: number; text: string }[] = [];
      const visit = (node: TsNode): void => {
        if (DEFINITION_TYPES.has(node.type) && nameOf(node) === symbol) {
          const row = node.startPosition.row as number;
          out.push({ line: row + 1, text: (lines[row] ?? "").trim().slice(0, 200) });
        }
        for (let i = 0; i < node.namedChildCount; i++) visit(node.namedChild(i));
      };
      visit(tree.rootNode);
      return out;
    } catch {
      return undefined; // any parse/extraction failure -> defer to the regex floor
    } finally {
      tree?.delete(); // free the WASM-backed tree
    }
  },
  ranges(rel, content) {
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

/**
 * Lazily load web-tree-sitter + grammars and register the AST backend ahead of
 * regex. Returns true once ready, false if unavailable (the regex floor stays).
 * Idempotent and safe to call before every repo_map/find_definition use.
 */
export async function ensureAstBackend(): Promise<boolean> {
  if (state === "ready") return true;
  if (state === "failed") return false;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const require = createRequire(import.meta.url);
      const wtsDir = path.dirname(require.resolve("web-tree-sitter/package.json"));
      const wasmsDir = path.join(path.dirname(require.resolve("tree-sitter-wasms/package.json")), "out");
      const mod: any = await import("web-tree-sitter");
      const Parser = mod.default ?? mod.Parser;
      await Parser.init({ locateFile: (name: string) => path.join(wtsDir, name) });
      const Language = Parser.Language ?? mod.Language;
      for (const g of new Set(Object.values(GRAMMARS))) {
        try {
          const lang = await Language.load(path.join(wasmsDir, `tree-sitter-${g}.wasm`));
          const p = new Parser();
          p.setLanguage(lang);
          parsers.set(g, p);
        } catch {
          // a grammar that fails to load is skipped; the rest still work
        }
      }
      if (parsers.size === 0) {
        state = "failed";
        return false;
      }
      symbolBackends.unshift(astBackend); // ahead of regex
      state = "ready";
      return true;
    } catch {
      state = "failed";
      return false;
    }
  })();
  return initPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
