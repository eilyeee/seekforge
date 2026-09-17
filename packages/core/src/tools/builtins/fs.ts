import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { type ChatImage, compareByCodePoints, DEFAULT_LIMITS } from "@seekforge/shared";
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
import { assertCurrentView, type FileLedger, stampFor } from "../file-ledger.js";
import { type IgnoreFrame, WorkspaceIgnore } from "../gitignore.js";
import { extractPdfText } from "../pdf.js";

const MAX_LIST_ENTRIES = 500;
const DEFAULT_SEARCH_MATCHES = 1000;
const MAX_SEARCH_MATCHES = 5000;
const MAX_SEARCHABLE_FILE_BYTES = 1_000_000;
const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CONTEXT_LINES = 10;
/**
 * Ceiling on an image read_file attaches. Its base64 form (4MB) stays inside
 * both the per-image limit the transcript accepts on replay (agent/trace.ts)
 * and the 5MB per-image limit of the strictest vision API we speak to.
 */
const MAX_READ_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_PDF_FILE_BYTES = 50 * 1024 * 1024;

const INCLUDE_IGNORED_DESCRIPTION =
  "Also include .gitignore'd paths (default false). node_modules/.git/dist-style directories stay skipped; pass one as path to look inside it.";

function joinRel(a: string, b: string): string {
  if (a === "") return b;
  if (b === "") return a;
  return `${a}/${b}`;
}

/**
 * The ignore matcher for a walk rooted at `root` (a resolved path inside the
 * workspace), or undefined when the caller asked to include ignored paths.
 * Rules apply to what is BELOW the root: naming an ignored directory as the
 * path is how the model looks inside it.
 */
function ignoreFor(
  ctx: ToolContext,
  root: string,
  includeIgnored: boolean | undefined,
): { matcher: WorkspaceIgnore; rootRel: string; frame: IgnoreFrame } | undefined {
  if (includeIgnored) return undefined;
  const matcher = WorkspaceIgnore.forWorkspace(ctx.workspace);
  const rootRel = matcher.relativePath(root);
  return { matcher, rootRel, frame: matcher.frameFor(rootRel) };
}

/** Where the ledger files a path: the physical file locally, the logical path behind a runtime. */
function ledgerKey(ctx: ToolContext, resolvedOrRel: string): string {
  return ctx.runtime ? `runtime:${path.resolve(ctx.workspace, resolvedOrRel)}` : resolvedOrRel;
}

function readBoundedOrTooLarge(resolved: string, relPath: string): Buffer {
  try {
    return readFileBoundedSync(resolved, MAX_TOOL_FILE_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new ToolError("too_large", `File exceeds ${MAX_TOOL_FILE_BYTES} bytes: ${relPath}`);
    }
    throw error;
  }
}

/**
 * The read-before-edit check, run from `prepare` so a write the ledger will
 * refuse never reaches the approval prompt. `run` checks again: the file can
 * change while the user is deciding.
 */
function precheckLocalView(ctx: ToolContext, relPath: string): void {
  const ledger = ctx.fileLedger;
  if (!ledger || ctx.runtime) return;
  let resolved: string;
  let stat: fs.Stats | undefined;
  try {
    resolved = resolveForWrite(ctx.workspace, relPath);
    stat = fs.statSync(resolved, { throwIfNoEntry: false });
  } catch {
    return; // run() reports the path problem itself
  }
  if (!stat?.isFile()) return;
  try {
    assertCurrentView(ledger, resolved, relPath, {
      stat,
      content: () => readFileBoundedSync(resolved, MAX_TOOL_FILE_BYTES),
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    // An unreadable file is run()'s to report.
  }
}

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
 *
 * `guard` sees the same content and may refuse the write outright; unlike the
 * preview itself, its refusal is not swallowed.
 */
async function runtimePreview(
  ctx: ToolContext,
  relPath: string,
  computeAfter: (before: string | null) => string,
  guard?: (before: string | null) => void,
): Promise<PreparedCall> {
  if (!ctx.runtime) return {};
  let before: string | null;
  try {
    before = await runtimeBeforeContent(ctx, relPath, { signal: ctx.signal });
  } catch {
    // Best effort, exactly like the local preview: a failure here must never
    // stop the write the user may still approve.
    return {};
  }
  guard?.(before);
  try {
    // Match the local path's bound: a file too big to read locally is too big
    // to render as a prompt either.
    if (before !== null && Buffer.byteLength(before, "utf8") > MAX_TOOL_FILE_BYTES) return {};
    const preview = renderPreview(relPath, before, computeAfter(before));
    return preview ? { review: { preview } } : {};
  } catch {
    return {};
  }
}

function runtimeGuard(ctx: ToolContext, relPath: string): ((before: string | null) => void) | undefined {
  const ledger = ctx.fileLedger;
  if (!ledger) return undefined;
  return (before) => {
    if (before !== null) assertCurrentView(ledger, ledgerKey(ctx, relPath), relPath, { content: () => before });
  };
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
  includeIgnored: z.boolean().optional().describe(INCLUDE_IGNORED_DESCRIPTION),
});

function walkEntries(
  root: string,
  maxDepth: number,
  ignore: ReturnType<typeof ignoreFor>,
): { entries: string[]; truncated: boolean } {
  const entries: string[] = [];
  let truncated = false;

  const walk = (dir: string, rel: string, depth: number, frame: IgnoreFrame | undefined): void => {
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
      const isDir = d.isDirectory();
      if (isDir && DEFAULT_IGNORE_DIRS.has(d.name)) continue;
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      const wsRel = ignore ? joinRel(ignore.rootRel, childRel) : "";
      if (ignore && frame && ignore.matcher.ignores(frame, wsRel, isDir)) continue;
      if (entries.length >= MAX_LIST_ENTRIES) {
        truncated = true;
        return;
      }
      if (isDir) {
        entries.push(childRel + "/");
        if (depth + 1 <= maxDepth) {
          walk(path.join(dir, d.name), childRel, depth + 1, ignore ? ignore.matcher.descend(frame!, wsRel) : undefined);
        }
      } else {
        entries.push(childRel);
      }
    }
  };

  walk(root, "", 1, ignore?.frame);
  return { entries, truncated };
}

const listFiles = defineTool({
  name: "list_files",
  description:
    "Recursively list files and directories under path; directories end with '/'. Prefer this over search_text when exploring project structure rather than hunting for specific code. Build/dependency directories (node_modules, .git, dist, ...) and .gitignore'd paths are skipped (includeIgnored:true shows the latter) and output caps at 500 entries — narrow path or maxDepth if truncated.",
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
      const entries = args.includeIgnored ? res.entries : dropIgnoredEntries(ctx, args.path ?? ".", res.entries);
      return {
        // The same in-band sentinel the local walk appends. Without it the two
        // backends of one tool answer differently: a runtime-backed session
        // showed exactly 500 entries and nothing in the list saying so.
        data: {
          entries: res.truncated ? [...entries, `... [truncated at ${res.entries.length} entries]`] : entries,
          count: entries.length,
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
    const { entries, truncated } = walkEntries(root, maxDepth, ignoreFor(ctx, root, args.includeIgnored));
    if (truncated) entries.push(`... [truncated at ${MAX_LIST_ENTRIES} entries]`);
    return {
      data: { entries, count: entries.length, truncated },
      meta: { truncated },
    };
  },
});

/**
 * The runtime walks with its own fixed ignore set; apply the workspace's
 * .gitignore to its answer so one tool does not ignore different things per
 * backend. Best effort: a listing root that cannot be resolved here is
 * returned unfiltered.
 */
function dropIgnoredEntries(ctx: ToolContext, listPath: string, entries: string[]): string[] {
  let ignore: ReturnType<typeof ignoreFor>;
  try {
    ignore = ignoreFor(ctx, resolveInsideWorkspace(ctx.workspace, listPath), false);
  } catch {
    return entries;
  }
  if (!ignore) return entries;
  const { matcher, rootRel } = ignore;
  return entries.filter((entry) => {
    const isDir = entry.endsWith("/");
    return !matcher.isIgnored(joinRel(rootRel, isDir ? entry.slice(0, -1) : entry), isDir, rootRel);
  });
}

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
  pages: z
    .string()
    .optional()
    .describe('PDF only: page or inclusive page range to read, e.g. "3" or "1-5" (at most 20 pages per call).'),
});

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/** The image type the bytes actually are — the extension only chose this path. */
function sniffImageType(bytes: Buffer): ChatImage["mediaType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

function readImage(resolved: string, relPath: string): { data: unknown; images: ChatImage[]; bytes: Buffer } {
  let bytes: Buffer;
  try {
    bytes = readFileBoundedSync(resolved, MAX_READ_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new ToolError(
        "too_large",
        `Image exceeds ${MAX_READ_IMAGE_BYTES} bytes (3MB), too large to attach: ${relPath} — use image_analyze or a smaller copy`,
      );
    }
    throw error;
  }
  const mediaType = sniffImageType(bytes);
  if (!mediaType) {
    throw new ToolError("unsupported_image", `${relPath} is not a PNG, JPEG, GIF, or WebP image`);
  }
  // No "see attached" note: whether the image reaches the model is the
  // provider's answer, and the provider mapping says so either way.
  return {
    data: { path: relPath, type: "image", mediaType, bytes: bytes.length },
    images: [{ mediaType, dataBase64: bytes.toString("base64"), label: relPath }],
    bytes,
  };
}

function statRegularFile(resolved: string, relPath: string): fs.Stats {
  if (!fs.existsSync(resolved)) throw new ToolError("not_found", `File not found: ${relPath}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new ToolError("not_a_file", `Not a regular file: ${relPath}`);
  return stat;
}

const readFile = defineTool({
  name: "read_file",
  description:
    'Read the file at path (required before editing an existing file). Text: for large files pass offset (1-based line) and limit — output past 20k chars is head/tail truncated with a symbol outline of the file. Images (png/jpg/gif/webp, max 3MB) are attached for you to view. PDFs return their text (needs pdftotext); pass pages, e.g. "1-5", max 20 per call. Do not re-read a file you have not changed since the last read.',
  schema: readFileSchema,
  classify: (args) => ({
    permission: "readonly",
    description: `Read file ${args.path}`,
    path: args.path,
  }),
  async run(args, ctx) {
    const ext = path.extname(args.path).toLowerCase();
    // Binary formats are read from the local filesystem even in a runtime
    // session, as image_analyze does: the runtime protocol carries text only.
    if (IMAGE_EXTENSIONS.has(ext)) {
      const resolved = resolveForRead(ctx.workspace, args.path);
      const stat = statRegularFile(resolved, args.path);
      const { data, images, bytes } = readImage(resolved, args.path);
      // Local sessions only: behind a runtime, writes compare against text the
      // runtime returns, which these bytes would never match.
      if (!ctx.runtime) ctx.fileLedger?.set(resolved, stampFor(bytes, stat));
      return { data, images };
    }
    const isPdf = ext === ".pdf";
    if (args.pages !== undefined && !isPdf) {
      throw new ToolError("invalid_input", "pages applies to PDF files only; use offset/limit for text");
    }

    let content: string;
    let pdfInfo: { pages: string; totalPages?: number; note?: string } | undefined;
    if (isPdf) {
      const resolved = resolveForRead(ctx.workspace, args.path);
      const stat = statRegularFile(resolved, args.path);
      if (stat.size > MAX_PDF_FILE_BYTES) {
        throw new ToolError("too_large", `PDF exceeds ${MAX_PDF_FILE_BYTES} bytes: ${args.path}`);
      }
      const pdf = await extractPdfText({
        workspace: ctx.workspace,
        file: resolved,
        ...(args.pages !== undefined ? { pages: args.pages } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      content = pdf.text;
      pdfInfo = {
        pages: pdf.first === pdf.last ? String(pdf.first) : `${pdf.first}-${pdf.last}`,
        ...(pdf.totalPages !== undefined ? { totalPages: pdf.totalPages } : {}),
        ...(pdf.truncated ? { note: "The extracted text was cut short; read a smaller page range." } : {}),
      };
    } else if (ctx.runtime) {
      const res = await callRuntime<{ content: string }>(ctx.runtime, "read_file", ctx.workspace, {
        path: args.path,
      });
      content = res.content;
      ctx.fileLedger?.set(ledgerKey(ctx, args.path), stampFor(content));
    } else {
      const resolved = resolveForRead(ctx.workspace, args.path);
      // stat BEFORE reading: a stamp may pair older metadata with newer bytes
      // (the next check then falls back to the hash) but never the reverse.
      const stat = statRegularFile(resolved, args.path);
      const bytes = readBoundedOrTooLarge(resolved, args.path);
      content = bytes.toString("utf8");
      ctx.fileLedger?.set(resolved, stampFor(bytes, stat));
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
      // Warm tree-sitter in the background — never block a read on WASM init.
      // Hinted with this file, so reading one .py loads the Python grammar and
      // not the other nine.
      void ensureAstBackend([args.path]);
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
      data: {
        path: args.path,
        ...(pdfInfo ? { type: "pdf", ...pdfInfo } : {}),
        content: text,
        totalLines,
        ...(outline ? { outline } : {}),
      },
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
  includeIgnored: z.boolean().optional().describe(INCLUDE_IGNORED_DESCRIPTION),
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
    'Search file contents by regex pattern (e.g. "function\\s+createUser"). Invalid regex falls back to literal text; unsafe backtracking shapes are rejected. Case-insensitive per line by default; returns {file, line, text} up to 1000 matches (max 5000). Options: glob filters paths; contextLines adds surrounding lines; filesWithMatches returns paths only; multiline spans newlines. Skips binaries, files over 1MB, ignored dirs and .gitignore\'d paths (see includeIgnored). Use glob to find files by name.',
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
    // The sensitive-path policy is keyed by WORKSPACE-relative paths. The
    // reported `file` is relative to the search root, so searching
    // `.seekforge` reported "config.json" — and the check, fed that, let the
    // provider key through.
    const rootRel = path.relative(workspaceReal, root).split(path.sep).join("/");
    const rootIsFile = fs.statSync(root).isFile();
    const ignore = rootIsFile ? undefined : ignoreFor(ctx, root, args.includeIgnored);

    const matches: SearchMatch[] = [];
    const filesWithMatches: string[] = [];
    let truncated = false;

    /** Count the limiting unit (files in -l mode, otherwise individual matches). */
    const atCap = (): boolean => (args.filesWithMatches ? filesWithMatches.length >= cap : matches.length >= cap);

    const searchFile = (filePath: string, rel: string, wsRel: string): void => {
      if (!matchesGlob(rel)) return;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > MAX_SEARCHABLE_FILE_BYTES) return;
      if (isSensitiveBasename(path.basename(filePath)) || isSensitiveRelPath(wsRel)) return;
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

    const walk = (dir: string, rel: string, frame: IgnoreFrame | undefined): void => {
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
        const wsRel = joinRel(rootRel, childRel);
        if (d.isDirectory()) {
          if (DEFAULT_IGNORE_DIRS.has(d.name)) continue;
          if (childPath === sessionsDir) continue;
          if (ignore && frame && ignore.matcher.ignores(frame, wsRel, true)) continue;
          walk(childPath, childRel, ignore ? ignore.matcher.descend(frame!, wsRel) : undefined);
        } else if (d.isFile()) {
          if (ignore && frame && ignore.matcher.ignores(frame, wsRel, false)) continue;
          searchFile(childPath, childRel, wsRel);
        }
      }
    };

    if (rootIsFile) {
      searchFile(root, path.basename(root), rootRel);
    } else {
      walk(root, "", ignore?.frame);
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

/** Record what a write left on disk, so the model may edit it again without re-reading. */
function recordWritten(ledger: FileLedger | undefined, key: string, content: string, fd?: number): void {
  if (!ledger) return;
  const stat = fd !== undefined ? fs.fstatSync(fd) : undefined;
  ledger.set(key, stampFor(Buffer.from(content, "utf8"), stat));
}

const writeFileSchema = z.object({
  path: z.string().describe("File path relative to the workspace root."),
  content: z.string().describe("Complete file content (UTF-8) — replaces the entire file, nothing is merged."),
  overwrite: z.boolean().optional().describe("Allow replacing an existing file (default false); read the file first."),
});

const writeFile = defineTool({
  name: "write_file",
  description:
    "Write content as the COMPLETE file at path (parent directories are created). Whole-file replacement: use only for new files or intentional full rewrites — use apply_patch for any edit to an existing file. Fails if the file already exists unless overwrite is true, and overwriting needs a prior read_file of it (re-read if it changed since).",
  schema: writeFileSchema,
  prepare: (args, ctx) => {
    if (args.overwrite) precheckLocalView(ctx, args.path);
    return runtimePreview(
      ctx,
      args.path,
      () => args.content,
      args.overwrite ? runtimeGuard(ctx, args.path) : undefined,
    );
  },
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
    const ledger = ctx.fileLedger;
    if (ctx.runtime) {
      const guarded = ledger !== undefined && args.overwrite === true;
      const before = ctx.checkpoint || guarded ? await runtimeBeforeContent(ctx, args.path) : null;
      if (guarded && before !== null) runtimeGuard(ctx, args.path)?.(before);
      ctx.checkpoint?.(args.path, before);
      await callRuntime<{ path: string }>(ctx.runtime, "write_file", ctx.workspace, {
        path: args.path,
        content: args.content,
        overwrite: args.overwrite ?? false,
      });
      recordWritten(ledger, ledgerKey(ctx, args.path), args.content);
      return { data: { path: args.path, bytesWritten: Buffer.byteLength(args.content, "utf8") } };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    const exists = fs.existsSync(resolved);
    if (exists && !args.overwrite) {
      throw new ToolError("exists", `File already exists: ${args.path} (pass overwrite:true to replace)`);
    }
    const expected = exists ? fs.statSync(resolved) : undefined;
    let before: Buffer | undefined;
    const currentBytes = (): Buffer => {
      before ??= readBoundedOrTooLarge(resolved, args.path);
      return before;
    };
    if (expected && ledger) {
      assertCurrentView(ledger, resolved, args.path, { stat: expected, content: currentBytes });
    }
    if (ctx.checkpoint) {
      ctx.checkpoint(args.path, exists ? currentBytes().toString("utf8") : null);
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const fd = openVerifiedWrite(ctx.workspace, args.path, resolved, {
      create: true,
      exclusive: !args.overwrite && !exists,
      ...(expected ? { expected } : {}),
    });
    try {
      replaceFileContents(fd, args.content);
      recordWritten(ledger, resolved, args.content, fd);
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
            "Exact text copied VERBATIM from the current file (whitespace included); must occur exactly once unless replaceAll — include surrounding lines to disambiguate.",
          ),
        newString: z.string().describe("Replacement text, written with the same exactness as oldString."),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace EVERY exact occurrence of oldString (e.g. renaming a variable); default false."),
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
    'Edit the file at path with search/replace edits, applied atomically (any failure writes nothing). Read it with read_file first. Each oldString is copied VERBATIM from the current content (exact whitespace) and must match EXACTLY ONCE — add surrounding lines to make it unique — unless replaceAll:true, which replaces every exact occurrence. Prefer several small edits over one large rewrite. Example: {oldString:"const port = 3000;", newString:"const port = 8080;"}. On no_match/ambiguous/file_changed, re-read the file and retry.',
  schema: applyPatchSchema,
  prepare: (args, ctx) => {
    precheckLocalView(ctx, args.path);
    return runtimePreview(
      ctx,
      args.path,
      (before) => applyEdits(before ?? "", args.edits),
      runtimeGuard(ctx, args.path),
    );
  },
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
            preview: `- ${previewHunk(e.oldString)} → + ${previewHunk(e.newString)}${e.replaceAll ? " (every occurrence)" : ""}`,
          }))
        : undefined;
    const replacesAll = args.edits.some((e) => e.replaceAll);
    return {
      permission: "write",
      description: `Apply ${args.edits.length} edit(s) to ${args.path}${replacesAll ? " (replace-all included)" : ""}`,
      path: args.path,
      ...(preview ? { preview } : {}),
      ...(hunks ? { hunks } : {}),
    };
  },
  async run(args, ctx) {
    const requested = args.edits.length;
    // Per-hunk selection: when the user approved only a subset of edits,
    // filter to just those indices. Empty selection = apply nothing.
    if (ctx.selectedHunks !== undefined) {
      args = { ...args, edits: args.edits.filter((_, i) => ctx.selectedHunks!.includes(i)) };
    }
    // After a partial application the file holds content the model never
    // proposed as a whole, so it must look again before its next edit.
    const partial = args.edits.length < requested;
    const ledger = ctx.fileLedger;
    if (ctx.runtime) {
      const replacesAll = args.edits.some((e) => e.replaceAll);
      const key = ledgerKey(ctx, args.path);
      const before = ctx.checkpoint || ledger || replacesAll ? await runtimeBeforeContent(ctx, args.path) : undefined;
      if (typeof before === "string") runtimeGuard(ctx, args.path)?.(before);
      if (ctx.checkpoint) ctx.checkpoint(args.path, before ?? null);
      let next: string | undefined;
      let data: unknown;
      if (replacesAll) {
        // The runtime protocol's edits are unique-match only, so a replace-all
        // patch is applied here and written back whole.
        if (before === null || before === undefined) throw new ToolError("not_found", `File not found: ${args.path}`);
        next = applyEdits(before, args.edits);
        await callRuntime<{ path: string }>(ctx.runtime, "write_file", ctx.workspace, {
          path: args.path,
          content: next,
          overwrite: true,
        });
        data = { path: args.path, editsApplied: args.edits.length };
      } else {
        data = await callRuntime<{ path: string; editsApplied: number }>(ctx.runtime, "apply_patch", ctx.workspace, {
          path: args.path,
          edits: args.edits,
        });
        // The runtime applied exact unique matches, which is what applyEdits
        // does first too — so the result is reproducible here.
        try {
          next = typeof before === "string" ? applyEdits(before, args.edits) : undefined;
        } catch {
          next = undefined;
        }
      }
      if (ledger) {
        if (next !== undefined && !partial) recordWritten(ledger, key, next);
        else ledger.delete(key);
      }
      return { data: withPartialNote(data, partial) };
    }
    const resolved = resolveForWrite(ctx.workspace, args.path);
    // Editing implies reading current content back into hints: same read rules apply.
    resolveForRead(ctx.workspace, args.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new ToolError("not_found", `File not found: ${args.path}`);
    }
    const expected = fs.statSync(resolved);
    const raw = readBoundedOrTooLarge(resolved, args.path);
    // The bytes are in hand, so compare content rather than trusting the stat.
    if (ledger) assertCurrentView(ledger, resolved, args.path, { content: () => raw });
    const content = raw.toString("utf8");
    // applyEdits throws on no_match/ambiguous before anything is written.
    const next = applyEdits(content, args.edits);
    ctx.checkpoint?.(args.path, content);
    const fd = openVerifiedWrite(ctx.workspace, args.path, resolved, { create: false, exclusive: false, expected });
    try {
      replaceFileContents(fd, next);
      if (partial) ledger?.delete(resolved);
      else recordWritten(ledger, resolved, next, fd);
    } finally {
      fs.closeSync(fd);
    }
    return { data: withPartialNote({ path: args.path, editsApplied: args.edits.length }, partial) };
  },
});

function withPartialNote(data: unknown, partial: boolean): unknown {
  if (!partial || typeof data !== "object" || data === null) return data;
  return {
    ...data,
    note: "The user approved only some of the edits. Re-read the file before editing it again.",
  };
}

export const fsTools: ToolSpec[] = [listFiles, readFile, searchText, writeFile, applyPatch];
