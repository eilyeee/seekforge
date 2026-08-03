import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "../errors.js";
import { unifiedDiff } from "../diff.js";
import { resolveForRead, resolveForWrite } from "../sandbox.js";
import { openVerifiedWrite, replaceFileContents } from "../safe-write.js";
import { FileTooLargeError, readUtf8FileBoundedSync } from "../../util/fs.js";
import type { LspPosition } from "./client.js";

/**
 * Turning a language server's WorkspaceEdit into files on disk.
 *
 * A rename is the one LSP operation that WRITES, and it writes across files the
 * caller never named. Everything risky about that lives here: the edit is first
 * turned into a complete before/after plan — every target resolved inside the
 * workspace, every file read, every edit applied in memory — and only then is
 * anything written. So the user reviews a real diff, and a rename that cannot
 * be applied wholly is refused before it has half-applied itself.
 */

const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;
/** A rename that claims to touch more files than this is refused as implausible. */
const MAX_EDITED_FILES = 500;

export type LspTextEdit = { range: { start: LspPosition; end: LspPosition }; newText: string };

/** One file's complete before/after, ready to be reviewed and then written. */
export type PlannedFileEdit = {
  /** Workspace-relative path. */
  path: string;
  /** Absolute path, already checked as writable inside the workspace. */
  absolute: string;
  before: string;
  after: string;
  diff: string;
  edits: number;
};

export type WorkspaceEditPlan = {
  files: PlannedFileEdit[];
  totalEdits: number;
};

/**
 * Flatten a WorkspaceEdit into uri → edits.
 *
 * Servers answer in one of two shapes, and the newer `documentChanges` form can
 * also carry create/rename/delete FILE operations. We advertise no support for
 * those, and refuse them here rather than silently dropping them: a partially
 * honoured edit is worse than none.
 */
export function normalizeWorkspaceEdit(result: unknown): Map<string, LspTextEdit[]> {
  const byUri = new Map<string, LspTextEdit[]>();
  if (result === null || result === undefined) return byUri;
  if (typeof result !== "object") {
    throw new ToolError("lsp_error", "rename result must be a WorkspaceEdit object");
  }
  const edit = result as {
    changes?: Record<string, LspTextEdit[]>;
    documentChanges?: Array<{ textDocument?: { uri?: string }; edits?: LspTextEdit[]; kind?: string }>;
  };

  const add = (uri: string, edits: LspTextEdit[] | undefined): void => {
    if (!Array.isArray(edits) || edits.length === 0) return;
    for (const e of edits) {
      if (!e || typeof e !== "object" || typeof e.newText !== "string" || !e.range?.start || !e.range?.end) {
        throw new ToolError("lsp_error", `rename returned a malformed edit for ${uri}`);
      }
    }
    byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits]);
  };

  if (Array.isArray(edit.documentChanges)) {
    for (const change of edit.documentChanges) {
      if (change?.kind) {
        throw new ToolError(
          "unsupported_edit",
          `the language server wants to ${change.kind} a file as part of this rename, which is not applied here — rename the file yourself and retry`,
        );
      }
      const uri = change?.textDocument?.uri;
      if (typeof uri !== "string") {
        throw new ToolError("lsp_error", "rename returned a document change with no uri");
      }
      add(uri, change.edits);
    }
  }
  if (edit.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  return byUri;
}

/** Byte offsets where each line starts, handling \n, \r\n and lone \r. */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") starts.push(i + 1);
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      starts.push(i + 1);
    }
  }
  return starts;
}

/**
 * LSP position → string offset. `character` counts UTF-16 code units, which is
 * exactly what a JavaScript string index is, so no conversion is needed.
 *
 * A line past the end of the file means the server's view and the file on disk
 * have diverged; that is a stale edit and must fail rather than land somewhere
 * arbitrary. A character past the end of its line is clamped: servers routinely
 * point one past the last character to mean "end of line".
 */
function offsetAt(text: string, starts: number[], position: LspPosition, relPath: string): number {
  if (!Number.isInteger(position.line) || position.line < 0 || position.line >= starts.length) {
    throw new ToolError(
      "stale_edit",
      `${relPath} changed since the language server read it (edit points at line ${position.line + 1} of ${starts.length})`,
    );
  }
  const lineStart = starts[position.line]!;
  const lineEnd = position.line + 1 < starts.length ? starts[position.line + 1]! : text.length;
  const character = Math.max(0, position.character);
  return Math.min(lineStart + character, lineEnd);
}

/** Apply a file's text edits in memory, rejecting overlaps. */
export function applyTextEdits(text: string, edits: LspTextEdit[], relPath: string): string {
  const starts = lineStartOffsets(text);
  const ranges = edits.map((edit) => ({
    start: offsetAt(text, starts, edit.range.start, relPath),
    end: offsetAt(text, starts, edit.range.end, relPath),
    newText: edit.newText,
  }));
  for (const range of ranges) {
    if (range.end < range.start) {
      throw new ToolError("lsp_error", `rename returned an inverted range for ${relPath}`);
    }
  }
  // Apply back-to-front so earlier offsets stay valid. Sorting by start (then
  // end) first also makes overlaps adjacent and therefore detectable.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.start < ranges[i - 1]!.end) {
      throw new ToolError("overlapping_edits", `rename returned overlapping edits for ${relPath}`);
    }
  }
  let out = text;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    out = out.slice(0, range.start) + range.newText + out.slice(range.end);
  }
  return out;
}

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    throw new ToolError("lsp_error", `rename targets a non-file uri: ${uri}`);
  }
}

/**
 * Resolve, read and apply every edit in memory. Nothing is written; the result
 * is what the user reviews and what `applyWorkspaceEditPlan` then writes.
 *
 * Targets outside the workspace — a definition in node_modules or the language's
 * standard library — abort the whole plan. Renaming there is not something to do
 * quietly on the user's behalf.
 */
export function planWorkspaceEdit(workspace: string, byUri: Map<string, LspTextEdit[]>): WorkspaceEditPlan {
  if (byUri.size > MAX_EDITED_FILES) {
    throw new ToolError("too_many_files", `rename would touch ${byUri.size} files (limit ${MAX_EDITED_FILES})`);
  }
  const files: PlannedFileEdit[] = [];
  let totalEdits = 0;
  for (const [uri, edits] of byUri) {
    const absolute = uriToPath(uri);
    const relative = path.relative(workspace, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new ToolError(
        "outside_workspace",
        `rename would edit ${absolute}, outside the workspace — narrow the rename or edit that file directly`,
      );
    }
    const relPath = relative.split(path.sep).join("/");
    // Same gates as any other write: symlink escapes, sensitive paths.
    resolveForRead(workspace, relPath);
    const resolved = resolveForWrite(workspace, relPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `rename targets ${relPath}, which is not a regular file`);
    }
    let before: string;
    try {
      before = readUtf8FileBoundedSync(resolved, MAX_EDIT_FILE_BYTES);
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        throw new ToolError("too_large", `File exceeds ${MAX_EDIT_FILE_BYTES} bytes: ${relPath}`);
      }
      throw error;
    }
    const after = applyTextEdits(before, edits, relPath);
    if (after === before) continue;
    totalEdits += edits.length;
    files.push({
      path: relPath,
      absolute: resolved,
      before,
      after,
      diff: unifiedDiff(before, after, relPath),
      edits: edits.length,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalEdits };
}

/**
 * Write a reviewed plan. Each file is checkpointed before it is touched, the
 * write goes through the same verified path as every other tool write, and a
 * failure part-way through restores what was already written — a rename that
 * half-applied would leave the project not compiling with no obvious cause.
 */
export function applyWorkspaceEditPlan(
  workspace: string,
  plan: WorkspaceEditPlan,
  options: { checkpoint?: (path: string, before: string | null) => void; only?: readonly number[] },
): { written: PlannedFileEdit[]; skipped: PlannedFileEdit[] } {
  const chosen = options.only ? plan.files.filter((_, index) => options.only!.includes(index)) : [...plan.files];
  const skipped = plan.files.filter((file) => !chosen.includes(file));
  const written: PlannedFileEdit[] = [];
  try {
    for (const file of chosen) {
      // Re-stat immediately before the write so a file that changed since the
      // plan was built is caught by the descriptor identity check.
      const expected = fs.statSync(file.absolute);
      const current = readUtf8FileBoundedSync(file.absolute, MAX_EDIT_FILE_BYTES);
      if (current !== file.before) {
        throw new ToolError("stale_edit", `${file.path} changed after the rename was computed — re-run the rename`);
      }
      options.checkpoint?.(file.path, file.before);
      const fd = openVerifiedWrite(workspace, file.path, file.absolute, {
        create: false,
        exclusive: false,
        expected,
      });
      try {
        replaceFileContents(fd, file.after);
      } finally {
        fs.closeSync(fd);
      }
      written.push(file);
    }
  } catch (error) {
    for (const file of written.reverse()) {
      try {
        fs.writeFileSync(file.absolute, file.before, "utf8");
      } catch {
        // Best effort: the checkpoint above still lets `seekforge rewind`
        // restore anything this could not put back.
      }
    }
    throw error;
  }
  return { written, skipped };
}
