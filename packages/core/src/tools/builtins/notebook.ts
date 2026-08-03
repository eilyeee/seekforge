import * as fs from "node:fs";
import { z } from "zod";
import { ToolError } from "../errors.js";
import { unifiedDiff } from "../diff.js";
import { isRecord } from "../../util/guards.js";
import { readUtf8FileBoundedSync } from "../../util/fs.js";
import { resolveForRead, resolveForWrite } from "../sandbox.js";
import { replaceExistingFile } from "../safe-write.js";
import { defineTool, type ToolSpec } from "../registry.js";

/**
 * Jupyter notebooks, as cells rather than as JSON.
 *
 * `read_file` on a .ipynb returns a wall of JSON in which the code is a
 * character-escaped array of lines, and `apply_patch` on one means matching
 * that escaped text exactly. Both are technically possible and practically
 * useless, so notebooks get their own pair: read the cells, edit one cell.
 *
 * Writing preserves the file's existing shape — key order comes from the parse,
 * and the indentation is measured from the original — so editing one cell does
 * not reformat the whole notebook into an unreviewable diff.
 */

const MAX_NOTEBOOK_BYTES = 20 * 1024 * 1024;
/** Per-cell output text kept when reading; a plot or a stack trace can be huge. */
const MAX_OUTPUT_CHARS = 2_000;
const MAX_CELLS = 1_000;

type NotebookCell = {
  cell_type?: unknown;
  source?: unknown;
  outputs?: unknown;
  [key: string]: unknown;
};

type Notebook = {
  cells?: unknown;
  [key: string]: unknown;
};

/** Notebook `source` is either a string or an array of lines that already end in \n. */
function cellSource(cell: NotebookCell): string {
  const source = cell.source;
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.filter((line): line is string => typeof line === "string").join("");
  return "";
}

/**
 * Store source the way the file already does. nbformat writes an array of
 * lines; keeping that shape means the edit does not rewrite every other line of
 * the JSON as a side effect.
 */
function toSourceValue(text: string, likeArray: boolean): string | string[] {
  if (!likeArray) return text;
  const lines = text.split("\n");
  return lines
    .map((line, index) => (index === lines.length - 1 ? line : `${line}\n`))
    .filter((l, i, a) => l !== "" || i < a.length - 1);
}

/** Flatten one output to text: streams, results and errors all read as text. */
function outputText(output: unknown): string {
  if (!isRecord(output)) return "";
  const join = (value: unknown): string =>
    typeof value === "string" ? value : Array.isArray(value) ? value.filter((v) => typeof v === "string").join("") : "";
  if (output.output_type === "stream") return join(output.text);
  if (output.output_type === "error") {
    const name = typeof output.ename === "string" ? output.ename : "Error";
    const value = typeof output.evalue === "string" ? output.evalue : "";
    return `${name}: ${value}`.trim();
  }
  const data = isRecord(output.data) ? output.data : undefined;
  if (data) {
    const text = join(data["text/plain"]);
    if (text) return text;
    const image = Object.keys(data).find((key) => key.startsWith("image/"));
    if (image) return `[${image} output]`;
  }
  return "";
}

function parseNotebook(raw: string, relPath: string): { notebook: Notebook; cells: NotebookCell[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("invalid_notebook", `${relPath} is not valid JSON`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cells)) {
    throw new ToolError("invalid_notebook", `${relPath} has no "cells" array — is it a Jupyter notebook?`);
  }
  const cells = parsed.cells.filter(isRecord) as NotebookCell[];
  if (cells.length > MAX_CELLS) {
    throw new ToolError("too_large", `${relPath} has ${cells.length} cells (limit ${MAX_CELLS})`);
  }
  return { notebook: parsed as Notebook, cells };
}

function readNotebook(workspace: string, relPath: string): { raw: string; notebook: Notebook; cells: NotebookCell[] } {
  const resolved = resolveForRead(workspace, relPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new ToolError("not_found", `File not found: ${relPath}`);
  }
  const raw = readUtf8FileBoundedSync(resolved, MAX_NOTEBOOK_BYTES);
  return { raw, ...parseNotebook(raw, relPath) };
}

/**
 * How the file indents its JSON, so a rewrite matches it. nbformat writes one
 * space; an editor may have written two or four. Guessing wrong reformats every
 * line of the notebook.
 */
export function detectIndent(raw: string): number {
  const match = /\n(\s+)"/.exec(raw);
  const indent = match?.[1]?.replace(/\r/g, "").length ?? 1;
  return indent >= 1 && indent <= 8 ? indent : 1;
}

/** Serialize back, matching the original's indentation and trailing newline. */
export function serializeNotebook(notebook: Notebook, raw: string): string {
  const text = JSON.stringify(notebook, null, detectIndent(raw));
  return raw.endsWith("\n") ? `${text}\n` : text;
}

const readSchema = z.object({
  path: z.string().describe("Workspace-relative path to the .ipynb file."),
  includeOutputs: z.boolean().optional().describe("Include each cell's outputs (default true)."),
});

const notebookRead = defineTool({
  name: "notebook_read",
  description:
    "Read a Jupyter notebook at `path` as cells: each cell's index, type (code/markdown), source, and — unless includeOutputs is false — what it printed or returned. " +
    "Use this instead of read_file for .ipynb, whose raw JSON escapes every line of code. Cell indices are what notebook_edit takes. Read-only.",
  schema: readSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read notebook ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const { cells } = readNotebook(ctx.workspace, args.path);
    const includeOutputs = args.includeOutputs !== false;
    return {
      data: {
        path: args.path,
        cells: cells.map((cell, index) => {
          const outputs =
            includeOutputs && Array.isArray(cell.outputs) ? cell.outputs.map(outputText).filter(Boolean) : [];
          const joined = outputs.join("\n");
          return {
            index,
            type: typeof cell.cell_type === "string" ? cell.cell_type : "code",
            source: cellSource(cell),
            ...(joined
              ? { output: joined.length > MAX_OUTPUT_CHARS ? `${joined.slice(0, MAX_OUTPUT_CHARS)}…` : joined }
              : {}),
          };
        }),
        count: cells.length,
      },
    };
  },
});

const editSchema = z
  .object({
    path: z.string().describe("Workspace-relative path to the .ipynb file."),
    cellIndex: z.number().int().min(0).describe("0-based cell index, as returned by notebook_read."),
    mode: z
      .enum(["replace", "insert", "delete"])
      .describe("replace the cell's source, insert a new cell BEFORE it, or delete it."),
    source: z.string().max(1_000_000).optional().describe("New cell source (required for replace and insert)."),
    cellType: z.enum(["code", "markdown"]).optional().describe("Type of an inserted cell (default code)."),
  })
  .refine((a) => a.mode === "delete" || a.source !== undefined, {
    message: "replace and insert need a source",
  });

const notebookEdit = defineTool({
  name: "notebook_edit",
  description:
    "Edit one cell of the Jupyter notebook at `path`: replace its source, insert a new cell before it, or delete it. " +
    "Use this instead of apply_patch for .ipynb — patching the raw JSON means matching escaped source text exactly. The rest of the notebook keeps its existing formatting.",
  schema: editSchema,
  classify: (args, ctx) => {
    const preview = ((): { path: string; diff: string } | undefined => {
      // Best effort, like every write preview: a diff of the CELL, since a diff
      // of the notebook's JSON is unreadable.
      try {
        const { cells } = readNotebook(ctx.workspace, args.path);
        const label = `${args.path}#cell${args.cellIndex}`;
        const before = cells[args.cellIndex] ? cellSource(cells[args.cellIndex]!) : null;
        const after = args.mode === "delete" ? "" : (args.source ?? "");
        return { path: label, diff: unifiedDiff(args.mode === "insert" ? null : before, after, label) };
      } catch {
        return undefined;
      }
    })();
    return {
      permission: "write",
      description: `${args.mode} cell ${args.cellIndex} of ${args.path}`,
      path: args.path,
      ...(preview ? { preview } : {}),
    };
  },
  async run(args, ctx) {
    const { raw, notebook, cells } = readNotebook(ctx.workspace, args.path);
    if (args.cellIndex >= cells.length && args.mode !== "insert") {
      throw new ToolError(
        "cell_not_found",
        `${args.path} has ${cells.length} cells; there is no cell ${args.cellIndex}`,
      );
    }
    if (args.cellIndex > cells.length) {
      throw new ToolError(
        "cell_not_found",
        `Cannot insert at ${args.cellIndex}: ${args.path} has ${cells.length} cells`,
      );
    }

    const next = [...cells];
    if (args.mode === "delete") {
      next.splice(args.cellIndex, 1);
    } else if (args.mode === "insert") {
      // Match the surrounding cells' source shape so the file stays uniform.
      const likeArray = cells.some((cell) => Array.isArray(cell.source)) || cells.length === 0;
      const cell: NotebookCell = {
        cell_type: args.cellType ?? "code",
        metadata: {},
        source: toSourceValue(args.source ?? "", likeArray),
        ...(args.cellType === "markdown" ? {} : { execution_count: null, outputs: [] }),
      };
      next.splice(args.cellIndex, 0, cell);
    } else {
      const current = cells[args.cellIndex]!;
      next[args.cellIndex] = {
        ...current,
        source: toSourceValue(args.source ?? "", Array.isArray(current.source)),
        // The stored outputs describe the OLD source; keeping them would show a
        // result that was never produced by the code now in the cell.
        ...(Array.isArray(current.outputs) ? { outputs: [], execution_count: null } : {}),
      };
    }

    const updated = serializeNotebook({ ...notebook, cells: next }, raw);
    const resolved = resolveForWrite(ctx.workspace, args.path);
    const expected = fs.statSync(resolved);
    ctx.checkpoint?.(args.path, raw);
    replaceExistingFile(ctx.workspace, args.path, resolved, updated, expected);
    return { data: { path: args.path, mode: args.mode, cellIndex: args.cellIndex, cells: next.length } };
  },
});

export const notebookTools: ToolSpec[] = [notebookRead, notebookEdit];
