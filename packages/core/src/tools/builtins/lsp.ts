import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveForRead } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";
import { lspDefinition, lspReferences, lspDiagnostics, severityLabel, type LspLocation } from "../lsp/client.js";

/**
 * Language Server Protocol tools: PRECISE symbol information from a real
 * language server (the compiler's own view), as opposed to the lexical guesses
 * of `repo_map` / `find_definition` / `search_text`.
 *
 * Like the browser tools, a language server is an OPTIONAL external binary the
 * user installs themselves (`typescript-language-server`, `pyright-langserver`,
 * `gopls`, …). Nothing here is a declared dependency: the server is spawned
 * lazily by ../lsp/client.ts, and when no server binary is found on PATH each
 * tool returns a clear `lsp_unavailable` install hint instead of crashing.
 *
 * All three tools only READ/ANALYZE, so they are classified `readonly` — like
 * the browser inspect tools (snapshot/console).
 */

// Positions are LSP 0-based; our `line` input is 1-based (matching editor/tool
// convention elsewhere) and `character` is 0-based (0 = start of line).
const positionSchema = {
  path: z.string().describe("Workspace-relative path to the source file (e.g. src/app.ts)."),
  line: z.number().int().min(1).describe("1-based line number of the symbol."),
  character: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based column of the symbol on that line (default 0 = start of line)."),
};

const definitionSchema = z.object(positionSchema);
const referencesSchema = z.object(positionSchema);
const diagnosticsSchema = z.object({
  path: z.string().describe("Workspace-relative path to the source file to analyze (e.g. src/app.ts)."),
});

/** Render an LSP location as a workspace-relative `file:line:character` triple. */
function formatLocation(
  workspace: string,
  loc: LspLocation,
): {
  path: string;
  line: number;
  character: number;
} {
  let filePath = loc.uri;
  try {
    const abs = fileUriToPath(loc.uri);
    const rel = path.relative(workspace, abs);
    // Keep repo-internal paths relative; leave out-of-tree ones (stdlib, deps) absolute.
    filePath = rel && !rel.startsWith("..") ? rel : abs;
  } catch {
    // Fall back to the raw uri if it is not a parseable file: uri.
  }
  return {
    path: filePath,
    line: loc.range.start.line + 1, // back to 1-based for display
    character: loc.range.start.character,
  };
}

function fileUriToPath(uri: string): string {
  // Node's fileURLToPath handles Windows drive letters (file:///C:/…) and UNC
  // hosts correctly; a manual `new URL(uri).pathname` mangles both.
  return fileURLToPath(uri);
}

const lspDefinitionTool = defineTool({
  name: "lsp_definition",
  description:
    "Go-to-definition via a real language server: given a `path` plus a `line` (and optional `character`), return the EXACT file(s) and line where that symbol is defined. " +
    "More precise than the lexical find_definition/repo_map because it uses the compiler's own resolution (imports, overloads, re-exports). " +
    "Requires a language server installed on PATH (typescript-language-server, pyright/pylsp, gopls); returns an install hint if absent. Read-only.",
  schema: definitionSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP definition at ${args.path}:${args.line}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const locations = await lspDefinition(
      ctx.workspace,
      abs,
      {
        line: args.line - 1,
        character: args.character ?? 0,
      },
      ctx.signal,
    );
    const definitions = locations.map((l) => formatLocation(ctx.workspace, l));
    return { data: { definitions, count: definitions.length } };
  },
});

const lspReferencesTool = defineTool({
  name: "lsp_references",
  description:
    "Find ALL references to the symbol at a `path` + `line` (optional `character`) via a real language server — every read/write/call site the compiler resolves, not lexical name matches. " +
    "Use before renaming or to gauge blast radius. Requires a language server on PATH (typescript-language-server, pyright/pylsp, gopls); returns an install hint if absent. Read-only.",
  schema: referencesSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP references at ${args.path}:${args.line}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const locations = await lspReferences(
      ctx.workspace,
      abs,
      {
        line: args.line - 1,
        character: args.character ?? 0,
      },
      ctx.signal,
    );
    const references = locations.map((l) => formatLocation(ctx.workspace, l));
    return { data: { references, count: references.length } };
  },
});

const lspDiagnosticsTool = defineTool({
  name: "lsp_diagnostics",
  description:
    "Open the file at `path` in a real language server and return its diagnostics (errors/warnings with line + message) — the precise 'did my change break something' signal, straight from the compiler/type-checker. " +
    "Far more accurate than grepping for error strings. Requires a language server on PATH (typescript-language-server, pyright/pylsp, gopls); returns an install hint if absent. Read-only.",
  schema: diagnosticsSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP diagnostics for ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const diags = await lspDiagnostics(ctx.workspace, abs, ctx.signal);
    const diagnostics = diags.map((d) => ({
      line: d.range.start.line + 1, // 1-based for display
      character: d.range.start.character,
      severity: severityLabel(d.severity),
      message: d.message,
      ...(d.source ? { source: d.source } : {}),
      ...(d.code != null ? { code: d.code } : {}),
    }));
    return { data: { path: args.path, diagnostics, count: diagnostics.length } };
  },
});

export const lspTools: ToolSpec[] = [lspDefinitionTool, lspReferencesTool, lspDiagnosticsTool];
