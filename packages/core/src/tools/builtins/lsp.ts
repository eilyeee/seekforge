import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { resolveForRead } from "../sandbox.js";
import { defineTool, type ToolSpec } from "../registry.js";
import {
  lspCodeActions,
  lspDefinition,
  lspDiagnostics,
  lspDocumentSymbols,
  lspFormatting,
  lspHover,
  lspReferences,
  lspRename,
  lspResolveCodeAction,
  lspWorkspaceSymbols,
  severityLabel,
  type LspLocation,
  type LspRange,
} from "../lsp/client.js";
import {
  applyWorkspaceEditPlan,
  normalizeWorkspaceEdit,
  planWorkspaceEdit,
  type WorkspaceEditPlan,
} from "../lsp/workspace-edit.js";

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
 * Most only READ/ANALYZE, so they are classified `readonly` — like the browser
 * inspect tools (snapshot/console). The three that write — rename, apply a code
 * action, format — all go through the same path: compute the server's edit in
 * `prepare`, show it as a diff, apply it all-or-nothing.
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

// ---------------------------------------------------------------------------
// lsp_hover / lsp_document_symbols
// ---------------------------------------------------------------------------

const hoverSchema = z.object(positionSchema);

const lspHoverTool = defineTool({
  name: "lsp_hover",
  description:
    "What the compiler knows about the symbol at `path` + `line` (optional `character`): its resolved type or signature, and its doc comment. " +
    "Cheaper and more reliable than reading the definition — inferred types and overload resolution are already applied. " +
    "Requires a language server on PATH (typescript-language-server, pyright/pylsp, gopls); returns an install hint if absent. Read-only.",
  schema: hoverSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP hover at ${args.path}:${args.line}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const text = await lspHover(
      ctx.workspace,
      abs,
      { line: args.line - 1, character: args.character ?? 0 },
      ctx.signal,
    );
    if (text === "") {
      throw new ToolError(
        "no_hover",
        `The language server has nothing for ${args.path}:${args.line} — check the position points at a symbol.`,
      );
    }
    return { data: { path: args.path, line: args.line, hover: text } };
  },
});

const documentSymbolsSchema = z.object({
  path: z.string().describe("Workspace-relative path to outline (e.g. src/app.ts)."),
});

const lspDocumentSymbolsTool = defineTool({
  name: "lsp_document_symbols",
  description:
    "Outline one file from the compiler's own parse: every class, function, method, type and constant in `path`, in source order, with its kind, 1-based line and nesting depth. " +
    "The precise counterpart to repo_map — use it to find your way around a large file without reading all of it. " +
    "Requires a language server on PATH; returns an install hint if absent. Read-only.",
  schema: documentSymbolsSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP outline of ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const found = await lspDocumentSymbols(ctx.workspace, abs, ctx.signal);
    const symbols = found.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line + 1, // 1-based for display, like every other tool
      depth: symbol.depth,
      ...(symbol.detail ? { detail: symbol.detail } : {}),
    }));
    return { data: { path: args.path, symbols, count: symbols.length } };
  },
});

// ---------------------------------------------------------------------------
// lsp_rename — the one LSP tool that writes
// ---------------------------------------------------------------------------

/** Cap the reviewed diff so a sweeping rename cannot flood the prompt. */
const MAX_PREVIEW_FILES = 20;

const renameSchema = z.object({
  ...positionSchema,
  newName: z
    .string()
    .min(1)
    .max(200)
    .describe("The new identifier. The language server rejects a name that is not valid for the symbol."),
});

/** Join the per-file diffs into one reviewable patch, capped by file count. */
function combineDiffs(plan: WorkspaceEditPlan): string {
  const shown = plan.files.slice(0, MAX_PREVIEW_FILES);
  const body = shown.map((file) => file.diff).join("\n");
  const hidden = plan.files.length - shown.length;
  return hidden > 0 ? `${body}\n@@ … ${hidden} more file(s) not shown @@` : body;
}

const lspRenameTool = defineTool({
  name: "lsp_rename",
  description:
    "Rename the symbol at `path` + `line` (optional `character`) to `newName` EVERYWHERE the language server resolves it — declaration plus every reference, across files. " +
    "Use this instead of search/replace for renames: it follows imports, re-exports and overloads, and never touches a same-named unrelated symbol. " +
    "Applied all-or-nothing after you approve the diff; edits outside the workspace abort it. Requires a language server on PATH; returns an install hint if absent.",
  schema: renameSchema,
  classify: (args) => ({
    permission: "write",
    description: `Rename the symbol at ${args.path}:${args.line} to ${args.newName}`,
    path: args.path,
  }),
  // The blast radius of a rename is only known after asking the language
  // server, which classify (synchronous) cannot do. Computing it here means the
  // user approves a real diff rather than an intention.
  async prepare(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const edit = await lspRename(
      ctx.workspace,
      abs,
      { line: args.line - 1, character: args.character ?? 0 },
      args.newName,
      ctx.signal,
    );
    const plan = planWorkspaceEdit(ctx.workspace, normalizeWorkspaceEdit(edit));
    if (plan.files.length === 0) {
      throw new ToolError(
        "no_changes",
        `The language server produced no edits for ${args.path}:${args.line} — check the position points at a symbol, and that it is not already called ${args.newName}.`,
      );
    }
    return {
      review: {
        description:
          `Rename to ${args.newName}: ${plan.totalEdits} edit(s) in ${plan.files.length} file(s) — ` +
          plan.files
            .slice(0, 5)
            .map((file) => file.path)
            .join(", ") +
          (plan.files.length > 5 ? ", …" : ""),
        preview: { path: args.path, diff: combineDiffs(plan) },
        // One hunk per file, so a reviewer can hold back a generated or vendored
        // file. Anything held back is reported as skipped: a partial rename
        // leaves references pointing at the old name.
        ...(plan.files.length > 1
          ? {
              hunks: plan.files.map((file, index) => ({
                index,
                preview: `${file.path} (${file.edits} edit(s))`,
              })),
            }
          : {}),
      },
      state: plan,
    };
  },
  async run(args, ctx) {
    const plan = ctx.prepared as WorkspaceEditPlan | undefined;
    if (!plan) {
      throw new ToolError("internal_error", "lsp_rename ran without a prepared edit plan");
    }
    const { written, skipped } = applyWorkspaceEditPlan(ctx.workspace, plan, {
      ...(ctx.checkpoint ? { checkpoint: ctx.checkpoint } : {}),
      ...(ctx.selectedHunks !== undefined ? { only: ctx.selectedHunks } : {}),
    });
    return {
      data: {
        newName: args.newName,
        files: written.map((file) => ({ path: file.path, edits: file.edits })),
        filesChanged: written.length,
        editsApplied: written.reduce((sum, file) => sum + file.edits, 0),
        // Named explicitly: the rename is incomplete and the model must decide
        // what to do about the references it left behind.
        ...(skipped.length > 0 ? { skipped: skipped.map((file) => file.path) } : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// lsp_symbols
// ---------------------------------------------------------------------------

const symbolsSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Symbol name or fragment to search for; most servers match on a subsequence, not just a prefix."),
  path: z
    .string()
    .optional()
    .describe("Any file in the language to search, when no language server is running for this workspace yet."),
  limit: z.number().int().min(1).max(200).optional().describe("Maximum symbols to return (default 50)."),
});

const DEFAULT_SYMBOL_LIMIT = 50;

const lspSymbolsTool = defineTool({
  name: "lsp_symbols",
  description:
    "Search the WHOLE project for a symbol by name (`query`) via a real language server: classes, functions, methods, types, constants — each with its kind and exact path:line. " +
    "Use it to find where something lives when you only know its name; unlike search_text it matches declarations, not every mention, and knows what kind of thing each one is. " +
    "Pass `path` (any file in the language) if no language server is running yet. Read-only.",
  schema: symbolsSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP symbol search for ${args.query}`,
    ...(args.path !== undefined ? { path: args.path } : {}),
  }),
  async run(args, ctx) {
    const hint = args.path === undefined ? undefined : resolveForRead(ctx.workspace, args.path);
    const found = await lspWorkspaceSymbols(ctx.workspace, args.query, hint, ctx.signal);
    const limit = args.limit ?? DEFAULT_SYMBOL_LIMIT;
    const symbols = found.slice(0, limit).map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      ...formatLocation(ctx.workspace, { uri: symbol.uri, range: symbol.range }),
      ...(symbol.container ? { container: symbol.container } : {}),
    }));
    return {
      data: {
        symbols,
        count: symbols.length,
        ...(found.length > symbols.length ? { truncated: true, totalFound: found.length } : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// lsp_code_actions / lsp_apply_code_action — the compiler's own fixes
// ---------------------------------------------------------------------------

/** The slice of a CodeAction this tool reads. */
type CodeAction = {
  title?: unknown;
  kind?: unknown;
  isPreferred?: unknown;
  disabled?: { reason?: unknown };
  edit?: unknown;
  command?: unknown;
  data?: unknown;
};

const rangeSchema = {
  path: z.string().describe("Workspace-relative path to the source file (e.g. src/app.ts)."),
  line: z.number().int().min(1).describe("1-based line the fix applies to — usually a line lsp_diagnostics reported."),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based last line, when the fix spans a range (default: line)."),
};

/** 1-based inclusive line range → the LSP's 0-based half-open range. */
function lineRange(line: number, endLine?: number): LspRange {
  const start = line - 1;
  const end = Math.max(start, (endLine ?? line) - 1);
  return { start: { line: start, character: 0 }, end: { line: end, character: Number.MAX_SAFE_INTEGER } };
}

function describeActions(actions: CodeAction[]): string {
  const titles = actions.map((a) => String(a.title)).filter(Boolean);
  return titles.length > 0 ? titles.map((t) => `"${t}"`).join(", ") : "none";
}

/** Keep only the entries that are real, applicable code actions. */
function usableActions(result: unknown): CodeAction[] {
  if (!Array.isArray(result)) return [];
  return result.filter(
    (item): item is CodeAction =>
      typeof item === "object" && item !== null && typeof (item as CodeAction).title === "string",
  );
}

const codeActionsSchema = z.object({
  ...rangeSchema,
  kind: z
    .string()
    .max(64)
    .optional()
    .describe('Narrow to one family, e.g. "quickfix" (fixes for a diagnostic) or "source.organizeImports".'),
});

const lspCodeActionsTool = defineTool({
  name: "lsp_code_actions",
  description:
    "List the fixes the language server itself offers for `path` at `line` (optionally through `endLine`) — add the missing import, remove the unused symbol, implement the interface. " +
    "The diagnostics reported on those lines are sent along, so the answers are fixes for the actual errors. Apply one with lsp_apply_code_action, by its title. " +
    "Requires a language server on PATH; returns an install hint if absent. Read-only.",
  schema: codeActionsSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `LSP code actions at ${args.path}:${args.line}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const result = await lspCodeActions(ctx.workspace, abs, lineRange(args.line, args.endLine), args.kind, ctx.signal);
    const actions = usableActions(result).map((action) => ({
      title: String(action.title),
      ...(typeof action.kind === "string" ? { kind: action.kind } : {}),
      ...(action.isPreferred === true ? { preferred: true } : {}),
      ...(action.disabled && typeof action.disabled.reason === "string" ? { unavailable: action.disabled.reason } : {}),
    }));
    return { data: { path: args.path, line: args.line, actions, count: actions.length } };
  },
});

const applyCodeActionSchema = z.object({
  ...rangeSchema,
  title: z.string().min(1).max(200).describe("Exact title of the action to apply, as returned by lsp_code_actions."),
});

/**
 * Fetch the named action's edit, resolving it when the server deferred it.
 * A server may answer a code action with a `command` for it to run itself
 * instead of an edit; that is not something this applies on the user's behalf,
 * so it is refused rather than silently skipped.
 */
async function planCodeAction(
  ctx: { workspace: string; signal?: AbortSignal },
  args: { path: string; line: number; endLine?: number; title: string },
): Promise<WorkspaceEditPlan> {
  const abs = resolveForRead(ctx.workspace, args.path);
  const range = lineRange(args.line, args.endLine);
  const actions = usableActions(await lspCodeActions(ctx.workspace, abs, range, undefined, ctx.signal));
  const chosen = actions.find((action) => String(action.title) === args.title);
  if (!chosen) {
    throw new ToolError(
      "action_not_found",
      `No code action titled "${args.title}" at ${args.path}:${args.line} — available: ${describeActions(actions)}`,
    );
  }
  if (chosen.disabled && typeof chosen.disabled.reason === "string") {
    throw new ToolError("action_unavailable", `"${args.title}" is unavailable: ${chosen.disabled.reason}`);
  }
  let edit = chosen.edit;
  if (edit === undefined && chosen.data !== undefined) {
    const resolved = (await lspResolveCodeAction(ctx.workspace, abs, chosen, ctx.signal)) as CodeAction | undefined;
    edit = resolved?.edit;
  }
  if (edit === undefined) {
    throw new ToolError(
      "unsupported_action",
      `"${args.title}" asks the language server to run a command rather than edit files, which is not applied here`,
    );
  }
  const plan = planWorkspaceEdit(ctx.workspace, normalizeWorkspaceEdit(edit));
  if (plan.files.length === 0) {
    throw new ToolError("no_changes", `"${args.title}" produced no edits`);
  }
  return plan;
}

const lspApplyCodeActionTool = defineTool({
  name: "lsp_apply_code_action",
  description:
    "Apply the code action titled `title` at `path` + `line` (list them first with lsp_code_actions). The language server produces the edit; you approve the diff before anything is written. " +
    "Applied all-or-nothing across every file it touches; edits outside the workspace abort it. Prefer this over hand-editing a compiler-suggested fix. " +
    "Requires a language server on PATH; returns an install hint if absent.",
  schema: applyCodeActionSchema,
  classify: (args) => ({
    permission: "write",
    description: `Apply code action "${args.title}" at ${args.path}:${args.line}`,
    path: args.path,
  }),
  // The edit is only known after asking the server, so the review payload is
  // built here — the user approves a diff, not a title.
  async prepare(args, ctx) {
    const plan = await planCodeAction(ctx, args);
    return {
      review: {
        description:
          `Apply "${args.title}": ${plan.totalEdits} edit(s) in ${plan.files.length} file(s) — ` +
          plan.files.map((file) => file.path).join(", "),
        preview: { path: args.path, diff: combineDiffs(plan) },
        ...(plan.files.length > 1
          ? { hunks: plan.files.map((file, index) => ({ index, preview: `${file.path} (${file.edits} edit(s))` })) }
          : {}),
      },
      state: plan,
    };
  },
  async run(args, ctx) {
    const plan = ctx.prepared as WorkspaceEditPlan | undefined;
    if (!plan) throw new ToolError("internal_error", "lsp_apply_code_action ran without a prepared edit plan");
    const { written, skipped } = applyWorkspaceEditPlan(ctx.workspace, plan, {
      ...(ctx.checkpoint ? { checkpoint: ctx.checkpoint } : {}),
      ...(ctx.selectedHunks !== undefined ? { only: ctx.selectedHunks } : {}),
    });
    return {
      data: {
        applied: args.title,
        files: written.map((file) => ({ path: file.path, edits: file.edits })),
        filesChanged: written.length,
        ...(skipped.length > 0 ? { skipped: skipped.map((file) => file.path) } : {}),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// lsp_format
// ---------------------------------------------------------------------------

const formatSchema = z.object({
  path: z.string().describe("Workspace-relative path to format (e.g. src/app.ts)."),
  tabSize: z.number().int().min(1).max(16).optional().describe("Spaces per indent level (default 2)."),
  insertSpaces: z.boolean().optional().describe("Indent with spaces rather than tabs (default true)."),
});

const lspFormatTool = defineTool({
  name: "lsp_format",
  description:
    "Format the file at `path` with the language server's own formatter, and show the diff for approval before writing. " +
    "Use it after an edit when the project has no formatter of its own to run — otherwise prefer that project command. " +
    "Requires a language server on PATH; returns an install hint if absent.",
  schema: formatSchema,
  classify: (args) => ({
    permission: "write",
    description: `Format ${args.path} with the language server`,
    path: args.path,
  }),
  async prepare(args, ctx) {
    const abs = resolveForRead(ctx.workspace, args.path);
    const edits = await lspFormatting(
      ctx.workspace,
      abs,
      { tabSize: args.tabSize ?? 2, insertSpaces: args.insertSpaces ?? true },
      ctx.signal,
    );
    // Formatting answers with plain TextEdits for the one file; the shared
    // planner works in WorkspaceEdit terms, so wrap them as such.
    const plan = planWorkspaceEdit(
      ctx.workspace,
      normalizeWorkspaceEdit({ changes: { [pathToFileURL(abs).href]: edits } }),
    );
    if (plan.files.length === 0) {
      throw new ToolError("no_changes", `${args.path} is already formatted`);
    }
    return {
      review: {
        description: `Format ${args.path} (${plan.totalEdits} edit(s))`,
        preview: { path: args.path, diff: combineDiffs(plan) },
      },
      state: plan,
    };
  },
  async run(args, ctx) {
    const plan = ctx.prepared as WorkspaceEditPlan | undefined;
    if (!plan) throw new ToolError("internal_error", "lsp_format ran without a prepared edit plan");
    const { written } = applyWorkspaceEditPlan(ctx.workspace, plan, {
      ...(ctx.checkpoint ? { checkpoint: ctx.checkpoint } : {}),
    });
    return { data: { path: args.path, edits: written[0]?.edits ?? 0, formatted: written.length > 0 } };
  },
});

export const lspTools: ToolSpec[] = [
  lspDefinitionTool,
  lspReferencesTool,
  lspDiagnosticsTool,
  lspHoverTool,
  lspDocumentSymbolsTool,
  lspCodeActionsTool,
  lspApplyCodeActionTool,
  lspFormatTool,
  lspRenameTool,
  lspSymbolsTool,
];
