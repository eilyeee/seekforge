import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { compareByCodePoints, DEFAULT_LIMITS } from "@seekforge/shared";
import { ToolError } from "../errors.js";
import { applyEdits } from "../edits.js";
import {
  DEFAULT_IGNORE_DIRS,
  isSensitiveBasename,
  isSensitiveRelPath,
  resolveForRead,
  resolveForWrite,
  resolveInsideWorkspace,
} from "../sandbox.js";
import { truncateHeadTail } from "../text.js";
import { unifiedDiff } from "../diff.js";
import { openVerifiedWrite, replaceFileContents } from "../safe-write.js";
import { declRanges, extractSymbols } from "../../agent/repo-map.js";
import { ensureAstBackend } from "../../agent/repo-map-ast.js";
import { callRuntime } from "../runtime-backend.js";
import { compileGlob } from "./glob.js";
import { defineTool, type PreparedCall, type ToolSpec } from "../registry.js";
import type { ToolContext } from "../index.js";
import { FileTooLargeError, readFileBoundedSync, readUtf8FileBoundedSync } from "../../util/fs.js";

const MAX_LIST_ENTRIES = 500;
const DEFAULT_SEARCH_MATCHES = 1000;
const MAX_SEARCH_MATCHES = 5000;
const MAX_SEARCHABLE_FILE_BYTES = 1_000_000;
const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_LINES = 10;

/**
 * Reads the current content of a workspace file for a diff preview at classify
 * time. Returns null when the file does not exist — i.e. the write is a
 * creation. Never throws: a preview is best-effort and must never block a write.
 */
function readCurrentForPreview(ctx: ToolContext, relPath: string): string | null {
  try {
    const resolved = resolveForRead(ctx.workspace, relPath);
    return readUtf8FileBoundedSync(resolved, MAX_TOOL_FILE_BYTES);
  } catch {
    return null;
  }
}

/** Render before → after as a preview, or undefined when nothing changes. */
function renderPreview(
  relPath: string,
  before: string | null,
  after: string,
): { path: string; diff: string } | undefined {
  if (before === after) return undefined;
  return { path: relPath, diff: unifiedDiff(before, after, relPath) };
}

/** Best-effort write-tool preview; returns undefined on any failure. */
function buildPreview(
  ctx: ToolContext,
  relPath: string,
  computeAfter: (before: string | null) => string,
): { path: string; diff: string } | undefined {
  // A runtime-backed session keeps its files behind an async call that classify
  // cannot make. "Could not read it" is NOT "it does not exist": rendering the
  // diff from a null `before` claimed every overwrite was a brand-new file, so
  // the review showed additions and no deletions. Those sessions get their real
  // diff from `runtimePreview` in the tool's `prepare` step instead.
  if (ctx.runtime) return undefined;
  try {
    const before = readCurrentForPreview(ctx, relPath);
    return renderPreview(relPath, before, computeAfter(before));
  } catch {
    return undefined;
  }
}

/**
 * The same preview, for a session whose files live behind the runtime backend.
 *
 * Without this those sessions approve every write blind: the frontends fall
 * back to a bare allow/deny because no diff ever arrives. The read is async, so
 * it belongs in `prepare` — it runs after the call is classified and after the
 * policy has had its chance to refuse, but before the user is asked.
 */
async function runtimePreview(
  ctx: ToolContext,
  relPath: string,
  computeAfter: (before: string | null) => string,
): Promise<PreparedCall> {
  if (!ctx.runtime) return {};
  try {
    const before = await runtimeBeforeContent(ctx, relPath, { signal: ctx.signal });
    // Match the local path's bound: a file too big to read locally is too big
    // to render as a prompt either.
    if (before !== null && Buffer.byteLength(before, "utf8") > MAX_TOOL_FILE_BYTES) return {};
    const preview = renderPreview(relPath, before, computeAfter(before));
    return preview ? { review: { preview } } : {};
  } catch {
    // Best effort, exactly like the local preview: a failure here must never
    // stop the write the user may still approve.
    return {};
  }
}

// ---------------------------------------------------------------------------
// list_files
// ---------------------------------------------------------------------------

const listFilesSchema = z.object({
  path: z.string().optional().describe("Directory to list, relative to the workspace root (default '.')."),
  maxDepth: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe("Maximum recursion depth (0-100, default 10); lower it for a quick overview."),
});

function walkEntries(root: string, maxDepth: number): { entries: string[]; truncated: boolean } {
  const entries: string[] = [];
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > maxDepth) return;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Code units, matching the Rust runtime's byte order: this is one tool with
    // two backends, and it answered in two different orders depending on which
    // was configured.
    dirents.sort((a, b) => compareByCodePoints(a.name, b.name));
    for (const d of dirents) {
      if (truncated) return;
      if (d.isDirectory() && DEFAULT_IGNORE_DIRS.has(d.name)) continue;
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (d.isDirectory()) {
        entries.push(childRel + "/");
        walk(path.join(dir, d.name), childRel, depth + 1);
      } else {
        entries.push(childRel);
      }
    }
  };

  walk(root, "", 1);
  return { entries, truncated };
}

const listFiles = defineTool({
  name: "list_files",
  description:
    "Recursively list files and directories under path; directories end with '/'. Prefer this over search_text when exploring project structure rather than hunting for specific code. Build/dependency directories (node_modules, .git, dist, ...) are skipped and output caps at 500 entries — narrow path or maxDepth if truncated.",
  schema: listFilesSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `List files under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    if (ctx.runtime) {
      const res = await callRuntime<{ entries: string[]; truncated: boolean }>(
        ctx.runtime,
        "list_files",
        ctx.workspace,
        { path: args.path ?? ".", maxDepth: args.maxDepth ?? 10 },
      );
      return {
        // The same in-band sentinel the local walk appends. Without it the two
        // backends of one tool answer differently: a runtime-backed session
        // showed exactly 500 entries and nothing in the list saying so.
        data: {
          entries: res.truncated ? [...res.entries, `... [truncated at ${res.entries.length} entries]`] : res.entries,
          count: res.entries.length,
          truncated: res.truncated,
        },
        meta: { truncated: res.truncated },
      };
    }
    const root = resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new ToolError("not_found", `Not a directory: ${args.path ?? "."}`);
    }
    const maxDepth = args.maxDepth ?? 10;
    const { entries, truncated } = walkEntries(root, maxDepth);
    if (truncated) entries.push(`... [truncated at ${MAX_LIST_ENTRIES} entries]`);
    return {
      data: { entries, count: entries.length, truncated },
      meta: { truncated },
    };
  },
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const readFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based line number to start reading from (combine with limit for large files)."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return."),
});

const readFile = defineTool({
  name: "read_file",
  description:
    "Read the UTF-8 text file at path. For large files pass offset (1-based line) and limit to read only the range you need — output beyond 20k chars is head/tail truncated (and a symbol outline of the whole file is returned so you can re-read the right range). Do not re-read a file you have not changed since the last read; the earlier content is still valid.",
  schema: readFileSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read file ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    let content: string;
    if (ctx.runtime) {
      const res = await callRuntime<{ content: string }>(ctx.runtime, "read_file", ctx.workspace, {
        path: args.path,
      });
      content = res.content;
    } else {
      const resolved = resolveForRead(ctx.workspace, args.path);
      if (!fs.existsSync(resolved)) {
        throw new ToolError("not_found", `File not found: ${args.path}`);
      }
      if (!fs.statSync(resolved).isFile()) {
        throw new ToolError("not_a_file", `Not a regular file: ${args.path}`);
      }
      try {
        content = readUtf8FileBoundedSync(resolved, MAX_TOOL_FILE_BYTES);
      } catch (error) {
        if (error instanceof FileTooLargeError) {
          throw new ToolError("too_large", `File exceeds ${MAX_TOOL_FILE_BYTES} bytes: ${args.path}`);
        }
        throw error;
      }
    }
    const fullContent = content; // whole file, before offset/limit slicing
    const totalLines = content.split("\n").length;
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max((args.offset ?? 1) - 1, 0);
      const end = args.limit !== undefined ? start + args.limit : lines.length;
      content = lines.slice(start, end).join("\n");
    }
    // Code-aware truncation: when the content will be truncated, load tree-sitter
    // (lazy, once) and cut on top-level construct boundaries so a code file shows
    // whole functions rather than a severed one. Falls back to line-aware cuts.
    let ranges: { start: number; end: number }[] | undefined;
    if (content.length > DEFAULT_LIMITS.toolOutputMaxChars) {
      void ensureAstBackend(); // warm tree-sitter in the background — never block a read on WASM init
      ranges = declRanges(args.path, content); // code-aware cut only when AST is already warm; else line-aware
    }
    const { text, truncated } = truncateHeadTail(
      content,
      DEFAULT_LIMITS.toolOutputMaxChars,
      ranges ? { ranges } : undefined,
    );
    // On truncation, append a symbol outline of the whole file (regex floor, or
    // tree-sitter if loaded) so the model knows what's beyond the cut and can
    // re-read the right range. Empty for non-code/symbol-less files.
    const outline = truncated ? extractSymbols(args.path, fullContent) : "";
    return {
      data: { path: args.path, content: text, totalLines, ...(outline ? { outline } : {}) },
      meta: { truncated },
    };
  },
});

// ---------------------------------------------------------------------------
// search_text
// ---------------------------------------------------------------------------

const searchTextSchema = z.object({
  pattern: z
    .string()
    .describe(
      'JavaScript regular expression, e.g. "function\\\\s+createUser" (invalid regex is retried as literal text; unsafe backtracking shapes are rejected).',
    ),
  path: z.string().optional().describe("File or directory to search, relative to the workspace root (default '.')."),
  caseSensitive: z.boolean().optional().describe("Case-sensitive matching (default false)."),
  glob: z
    .string()
    .optional()
    .describe('Only search files whose path matches this glob, e.g. "*.ts" or "src/**/*.tsx".'),
  contextLines: z
    .number()
    .int()
    .min(0)
    .max(MAX_CONTEXT_LINES)
    .optional()
    .describe("Include up to N lines of context before and after each match (like grep -C, max 10)."),
  filesWithMatches: z
    .boolean()
    .optional()
    .describe("Return only the list of matching file paths, with no line content (like grep -l)."),
  multiline: z
    .boolean()
    .optional()
    .describe("Treat each file as one string so the pattern can span newlines (regex 's' flag)."),
  maxMatches: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_MATCHES)
    .optional()
    .describe("Cap on the number of results (default 1000, max 5000)."),
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type RegexGroup = { quantified: boolean; alternation: boolean };

/** Reject regex shapes whose backtracking can grow exponentially. */
function isConservativeRegex(pattern: string): boolean {
  const groups: RegexGroup[] = [{ quantified: false, alternation: false }];
  let escaped = false;
  let inClass = false;
  let previousGroup: RegexGroup | undefined;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (escaped) {
      if (/[1-9]/.test(ch)) return false;
      escaped = false;
      previousGroup = undefined;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      previousGroup = undefined;
      continue;
    }
    if (ch === "(") {
      groups.push({ quantified: false, alternation: false });
      previousGroup = undefined;
      continue;
    }
    if (ch === ")") {
      if (groups.length > 1) {
        previousGroup = groups.pop();
        const parent = groups[groups.length - 1]!;
        parent.quantified ||= previousGroup!.quantified;
        parent.alternation ||= previousGroup!.alternation;
      }
      continue;
    }
    if (ch === "|") {
      groups[groups.length - 1]!.alternation = true;
      previousGroup = undefined;
      continue;
    }
    if (ch === "?" && pattern[i - 1] === "(") continue;
    const brace = ch === "{" ? /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i))?.[0] : undefined;
    const quantified = ch === "*" || ch === "+" || ch === "?" || brace !== undefined;
    if (quantified) {
      if (previousGroup?.quantified || previousGroup?.alternation) return false;
      groups[groups.length - 1]!.quantified = true;
      previousGroup = undefined;
      if (brace !== undefined) i += brace.length - 1;
      continue;
    }
    previousGroup = undefined;
  }
  return true;
}

type SearchMatch = {
  file: string;
  line: number;
  text: string;
  /** Context lines before/after the match (only when contextLines > 0). */
  context?: { before: string[]; after: string[] };
};

const searchText = defineTool({
  name: "search_text",
  description:
    'Search file contents by regex pattern (e.g. "function\\s+createUser"). Invalid regex falls back to literal text; unsafe backtracking shapes are rejected. Case-insensitive per line by default; returns {file, line, text} up to 1000 matches (max 5000). Options: glob filters paths; contextLines adds surrounding lines; filesWithMatches returns paths only; multiline spans newlines. Skips binaries, files over 1MB, and ignored dirs. Use glob to find files by name.',
  schema: searchTextSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Search for /${args.pattern}/ under ${args.path ?? "."}`,
    path: args.path ?? ".",
  }),
  async run(args, ctx) {
    const root = resolveInsideWorkspace(ctx.workspace, args.path ?? ".");
    if (!fs.existsSync(root)) {
      throw new ToolError("not_found", `Path not found: ${args.path ?? "."}`);
    }
    let flags = args.caseSensitive ? "" : "i";
    if (args.multiline) flags += "s";
    if (!isConservativeRegex(args.pattern)) {
      throw new ToolError("unsafe_regex", "Pattern is rejected because it may cause excessive backtracking");
    }
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, flags);
    } catch {
      re = new RegExp(escapeRegExp(args.pattern), flags);
    }

    const cap = Math.max(1, Math.min(args.maxMatches ?? DEFAULT_SEARCH_MATCHES, MAX_SEARCH_MATCHES));
    const ctxLines = Math.max(0, Math.min(args.contextLines ?? 0, MAX_CONTEXT_LINES));
    const globRe = args.glob ? compileGlob(args.glob) : undefined;
    // ripgrep-style: a glob without "/" matches the basename anywhere in the
    // tree (e.g. "*.ts" hits "src/a.ts"); a glob with "/" matches the full path.
    const globOnBasename = args.glob !== undefined && !args.glob.includes("/");
    const matchesGlob = (rel: string): boolean =>
      globRe ? globRe.test(globOnBasename ? path.basename(rel) : rel) : true;

    // The agent's own session transcripts live under .seekforge/sessions; if
    // search descended into them it would ingest escaped copies of its own
    // prior tool output (a self-pollution feedback loop that also burns tokens).
    // Build this from the SAME realpath the walk root uses (resolveInsideWorkspace
    // resolves symlinks) — otherwise on a symlinked workspace (e.g. /tmp ->
    // /private/tmp on macOS) the strings never match and the guard is skipped.
    let workspaceReal = ctx.workspace;
    try {
      workspaceReal = fs.realpathSync(ctx.workspace);
    } catch {
      // keep the raw path if it can't be resolved
    }
    const sessionsDir = path.join(workspaceReal, ".seekforge", "sessions");

    const matches: SearchMatch[] = [];
    const filesWithMatches: string[] = [];
    let truncated = false;

    /** Count the limiting unit (files in -l mode, otherwise individual matches). */
    const atCap = (): boolean => (args.filesWithMatches ? filesWithMatches.length >= cap : matches.length >= cap);

    const searchFile = (filePath: string, rel: string): void => {
      if (!matchesGlob(rel)) return;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > MAX_SEARCHABLE_FILE_BYTES) return;
      if (isSensitiveBasename(path.basename(filePath)) || isSensitiveRelPath(rel)) return;
      let buf: Buffer;
      try {
        buf = readFileBoundedSync(filePath, MAX_SEARCHABLE_FILE_BYTES);
      } catch {
        return;
      }
      if (buf.subarray(0, 8192).includes(0)) return; // binary sniff: NUL byte
      const content = buf.toString("utf8");

      if (args.multiline) {
        // Whole-file search: report the 1-based start line of each match.
        const lines = content.split("\n");
        // Precompute byte→line via cumulative line lengths.
        const lineStarts: number[] = [0];
        for (let i = 0; i < lines.length; i++) {
          lineStarts.push(lineStarts[i]! + (lines[i] as string).length + 1);
        }
        const lineOf = (idx: number): number => {
          let lo = 0;
          let hi = lineStarts.length - 1;
          while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineStarts[mid]! <= idx) lo = mid;
            else hi = mid - 1;
          }
          return lo; // 0-based
        };
        const gre = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
        let m: RegExpExecArray | null;
        let matchedFile = false;
        while ((m = gre.exec(content)) !== null) {
          if (atCap()) {
            truncated = true;
            break;
          }
          matchedFile = true;
          if (!args.filesWithMatches) {
            const lineNo = lineOf(m.index);
            pushMatch(matches, lines, rel, lineNo, ctxLines);
          }
          if (m.index === gre.lastIndex) gre.lastIndex++; // avoid zero-width loop
          if (args.filesWithMatches) break;
        }
        if (matchedFile && args.filesWithMatches) filesWithMatches.push(rel);
        return;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (atCap()) {
          truncated = true;
          return;
        }
        const line = lines[i] as string;
        if (re.test(line)) {
          if (args.filesWithMatches) {
            filesWithMatches.push(rel);
            return;
          }
          pushMatch(matches, lines, rel, i, ctxLines);
        }
      }
    };

    const walk = (dir: string, rel: string): void => {
      if (truncated) return;
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // Code units, matching the Rust runtime's byte order: this is one tool with
      // two backends, and it answered in two different orders depending on which
      // was configured.
      dirents.sort((a, b) => compareByCodePoints(a.name, b.name));
      for (const d of dirents) {
        if (truncated) return;
        const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
        const childPath = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.has(d.name)) continue;
          if (childPath === sessionsDir) continue;
          walk(childPath, childRel);
        } else if (d.isFile()) {
          searchFile(childPath, childRel);
        }
      }
    };

    if (fs.statSync(root).isFile()) {
      searchFile(root, path.basename(root));
    } else {
      walk(root, "");
    }

    if (args.filesWithMatches) {
      return {
        data: { files: filesWithMatches, count: filesWithMatches.length, truncated },
        meta: { truncated },
      };
    }
    return {
      data: { matches, count: matches.length, truncated },
      meta: { truncated },
    };
  },
});

/** Append a single match (line index `i`, 0-based) with optional context. */
function pushMatch(matches: SearchMatch[], lines: string[], rel: string, i: number, ctxLines: number): void {
  const entry: SearchMatch = { file: rel, line: i + 1, text: (lines[i] as string).slice(0, 500) };
  if (ctxLines > 0) {
    const before = lines.slice(Math.max(0, i - ctxLines), i).map((l) => l.slice(0, 500));
    const after = lines.slice(i + 1, i + 1 + ctxLines).map((l) => l.slice(0, 500));
    entry.context = { before, after };
  }
  matches.push(entry);
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

/**
 * Fetches a file's current content through the runtime for checkpointing
 * before a delegated write. A missing/unreadable file maps to null (the
 * checkpoint semantics for "did not exist before this session").
 */
async function runtimeBeforeContent(
  ctx: ToolContext,
  relPath: string,
  opts?: { signal?: AbortSignal },
): Promise<string | null> {
  try {
    const res = await callRuntime<{ content: string }>(
      ctx.runtime!,
      "read_file",
      ctx.workspace,
      { path: relPath },
      opts?.signal ? { signal: opts.signal } : undefined,
    );
    return res.content;
  } catch (err) {
    if (err instanceof ToolError && (err.code === "not_found" || err.code === "io_error")) return null;
    throw err;
  }
}

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  content: z.string().describe("Complete file content (UTF-8) — replaces the entire file, nothing is merged."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file (default false)."),
});

const writeFile = defineTool({
  name: "write_file",
  description:
    "Write content as the COMPLETE file at path (parent directories are created). Whole-file replacement: use only for new files or intentional full rewrites — use apply_patch for any edit to an existing file. Fails if the file already exists unless overwrite is true.",
  schema: writeFileSchema,
  prepare: (args, ctx) => runtimePreview(ctx, args.path, () => args.content),
  classify: (args, ctx) => {
    const preview = buildPreview(ctx, args.path, () => args.content);
    return {
      permission: "write",
      description: `Write file ${args.path} (${args.content.length} chars)`,
      path: args.path,
      ...(preview ? { preview } : {}),
    };
  },
  async run(args, ctx) {
    if (ctx.runtime) {
      if (ctx.checkpoint) {
        ctx.checkpoint(args.path, await runtimeBeforeContent(ctx, args.path));
      }
      await callRuntime<{ path: string }>(ctx.runtime, "write_file", ctx.workspace, {
        path: args.path,
        content: args.content,
        overwrite: args.overwrite ?? false,
      });
      return { data: { path: args.path, bytesWritten: Buffer.byteLength(args.content, "utf8") } };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    const exists = fs.existsSync(resolved);
    if (exists && !args.overwrite) {
      throw new ToolError("exists", `File already exists: ${args.path} (pass overwrite:true to replace)`);
    }
    const expected = exists ? fs.statSync(resolved) : undefined;
    if (ctx.checkpoint) {
      try {
        ctx.checkpoint(args.path, exists ? readUtf8FileBoundedSync(resolved, MAX_TOOL_FILE_BYTES) : null);
      } catch (error) {
        if (error instanceof FileTooLargeError) {
          throw new ToolError("too_large", `File exceeds ${MAX_TOOL_FILE_BYTES} bytes: ${args.path}`);
        }
        throw error;
      }
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const fd = openVerifiedWrite(ctx.workspace, args.path, resolved, {
      create: true,
      exclusive: !args.overwrite && !exists,
      ...(expected ? { expected } : {}),
    });
    try {
      replaceFileContents(fd, args.content);
    } finally {
      fs.closeSync(fd);
    }
    return { data: { path: args.path, bytesWritten: Buffer.byteLength(args.content, "utf8") } };
  },
});

// ---------------------------------------------------------------------------
// apply_patch
// ---------------------------------------------------------------------------

const applyPatchSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  edits: z
    .array(
      z.object({
        oldString: z
          .string()
          .describe(
            "Exact text copied VERBATIM from the current file (whitespace included); must occur exactly once — include surrounding lines to disambiguate.",
          ),
        newString: z.string().describe("Replacement text, written with the same exactness as oldString."),
      }),
    )
    .describe("Search/replace edits, applied in order, all-or-nothing."),
});

function previewHunk(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0);
  if (!first) return "(empty)";
  return first.length > 80 ? first.slice(0, 80) + "…" : first;
}

const applyPatch = defineTool({
  name: "apply_patch",
  description:
    'Edit the file at path with search/replace edits, applied atomically (any failure writes nothing). Read the file first; each oldString must be copied VERBATIM from its current content (exact whitespace/indentation) and match EXACTLY ONCE — add surrounding lines to make it unique. newString is the replacement. Prefer several small targeted edits over one large rewrite. Example edit: {oldString:"const port = 3000;", newString:"const port = 8080;"}. If a patch fails (no_match/ambiguous), re-read the file and retry with the latest content.',
  schema: applyPatchSchema,
  prepare: (args, ctx) => runtimePreview(ctx, args.path, (before) => applyEdits(before ?? "", args.edits)),
  classify: (args, ctx) => {
    // applyEdits throws on no_match/ambiguous; buildPreview swallows it and the
    // preview is simply omitted — the real run will surface the same error.
    const preview = buildPreview(ctx, args.path, (before) => applyEdits(before ?? "", args.edits));
    // Per-hunk previews for multi-edit patches, so frontends can offer
    // per-hunk selection. Single-edit calls omit hunks (backward compatible).
    const hunks =
      args.edits.length > 1
        ? args.edits.map((e, i) => ({
            index: i,
            preview: `- ${previewHunk(e.oldString)} → + ${previewHunk(e.newString)}`,
          }))
        : undefined;
    return {
      permission: "write",
      description: `Apply ${args.edits.length} edit(s) to ${args.path}`,
      path: args.path,
      ...(preview ? { preview } : {}),
      ...(hunks ? { hunks } : {}),
    };
  },
  async run(args, ctx) {
    // Per-hunk selection: when the user approved only a subset of edits,
    // filter to just those indices. Empty selection = apply nothing.
    if (ctx.selectedHunks !== undefined) {
      args = { ...args, edits: args.edits.filter((_, i) => ctx.selectedHunks!.includes(i)) };
    }
    if (ctx.runtime) {
      if (ctx.checkpoint) {
        ctx.checkpoint(args.path, await runtimeBeforeContent(ctx, args.path));
      }
      const res = await callRuntime<{ path: string; editsApplied: number }>(ctx.runtime, "apply_patch", ctx.workspace, {
        path: args.path,
        edits: args.edits,
      });
      return { data: res };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    // Editing implies reading current content back into hints: same read rules apply.
    resolveForRead(ctx.workspace, args.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    const expected = fs.statSync(resolved);
    let content: string;
    try {
      content = readUtf8FileBoundedSync(resolved, MAX_TOOL_FILE_BYTES);
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        throw new ToolError("too_large", `File exceeds ${MAX_TOOL_FILE_BYTES} bytes: ${args.path}`);
      }
      throw error;
    }
    // applyEdits throws on no_match/ambiguous before anything is written.
    const next = applyEdits(content, args.edits);
    ctx.checkpoint?.(args.path, content);
    const fd = openVerifiedWrite(ctx.workspace, args.path, resolved, { create: false, exclusive: false, expected });
    try {
      replaceFileContents(fd, next);
    } finally {
      fs.closeSync(fd);
    }
    return { data: { path: args.path, editsApplied: args.edits.length } };
  },
});

export const fsTools: ToolSpec[] = [listFiles, readFile, searchText, writeFile, applyPatch];
