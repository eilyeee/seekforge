/**
 * Workspace file index + image uploads for the web composer (SERVER-API.md):
 * GET /api/files (the @ file picker) and POST /api/upload (image paste/drop).
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_IGNORE_DIRS, isSensitiveBasename, resolveInsideWorkspace } from "@seekforge/core";

/** Hard cap on the number of paths GET /api/files returns. */
export const FILE_LIST_LIMIT = 2000;

/** Extensions accepted by POST /api/upload (what core image_analyze supports). */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Decoded size cap for uploads (matches core image_analyze's 4MB limit). */
export const MAX_UPLOAD_BYTES = 4_000_000;

/** Content-Type by image extension for GET /api/raw. */
const RAW_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** The only subtree GET /api/raw will serve from (agent-uploaded images). */
const UPLOADS_PREFIX = ".seekforge/uploads/";

/** Generous read cap for a served image (covers the 4MB upload limit + headroom). */
export const MAX_RAW_BYTES = 8_000_000;

export type FileList = { files: string[]; truncated: boolean };

/**
 * BFS over the workspace (shallow files first — the likeliest @-targets),
 * returning workspace-relative paths with "/" separators. Skips
 * DEFAULT_IGNORE_DIRS members, dot-directories, and symlinks. `q` is a
 * case-insensitive substring filter on the relative path, applied while
 * scanning so deep matches are still found in large repos. `truncated` is
 * true when the limit cut the scan short.
 */
export function listWorkspaceFiles(root: string, q = "", limit = FILE_LIST_LIMIT): FileList {
  const needle = q.toLowerCase();
  const files: string[] = [];
  const queue: string[] = [""]; // workspace-relative directories
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        queue.push(childRel);
      } else if (entry.isFile()) {
        if (needle !== "" && !childRel.toLowerCase().includes(needle)) continue;
        if (files.length >= limit) return { files, truncated: true };
        files.push(childRel);
      }
    }
  }
  return { files, truncated: false };
}

/** `col`/`len` are the 0-based match offset and length within `text`. */
export type SearchHit = { path: string; line: number; text: string; col: number; len: number };
export type SearchResult = { hits: SearchHit[]; truncated: boolean; error?: string };
export type SearchOptions = { caseSensitive?: boolean; regex?: boolean; limit?: number };

const SEARCH_MAX_HITS = 200;
const SEARCH_MAX_FILES = 1500;
const SEARCH_MAX_FILE_BYTES = 500_000;
const SEARCH_MAX_LINE_LEN = 240;
/** Overall wall-clock budget; a slow/pathological query stops and reports truncated. */
const SEARCH_BUDGET_MS = 3000;
/** In regex mode, skip lines longer than this (minified/data lines drive ReDoS). */
const SEARCH_MAX_REGEX_LINE = 2000;
/** Yield to the event loop every this many files so concurrent requests aren't starved. */
const SEARCH_YIELD_EVERY = 50;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Content search across the workspace (the @-picker's ignore-aware file set):
 * literal or regex, case-insensitive by default. Records the first non-empty
 * match per line (with its column + length). Bounded on every axis — files,
 * file size (checked via stat before reading), total hits, and a wall-clock
 * budget — and reads asynchronously, yielding to the event loop so a big search
 * never blocks other requests. Regex mode skips very long lines and is
 * time-boxed as a pragmatic ReDoS guard. An invalid regex returns `error`.
 */
export async function searchWorkspaceContent(
  root: string,
  q: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  if (q === "") return { hits: [], truncated: false };
  const limit = opts.limit ?? SEARCH_MAX_HITS;
  const flags = opts.caseSensitive ? "" : "i";
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? q : escapeRegExp(q), flags);
  } catch {
    return { hits: [], truncated: false, error: "invalid regex" };
  }
  const { files, truncated: listTruncated } = listWorkspaceFiles(root, "", SEARCH_MAX_FILES);
  const hits: SearchHit[] = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let scanned = 0;
  for (const rel of files) {
    if (Date.now() > deadline) return { hits, truncated: true };
    if (++scanned % SEARCH_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
    let st: Awaited<ReturnType<typeof stat>>;
    try {
      st = await stat(join(root, rel));
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) continue; // size-gate BEFORE reading
    let buf: Buffer;
    try {
      buf = await readFile(join(root, rel));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (opts.regex && line.length > SEARCH_MAX_REGEX_LINE) continue;
      const m = re.exec(line);
      if (m && m[0].length > 0) {
        hits.push({ path: rel, line: i + 1, text: line.slice(0, SEARCH_MAX_LINE_LEN), col: m.index, len: m[0].length });
        if (hits.length >= limit) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: listTruncated };
}

/** Upload validation failure carrying the HTTP status/code to respond with. */
export class UploadError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Validates and saves an uploaded image (base64 JSON body) under
 * `.seekforge/uploads/img-<stamp>.<ext>`. Only the extension of `name` is
 * used — the client filename never reaches the disk path. Returns the
 * workspace-relative path (what core image_analyze consumes).
 */
export function saveUpload(root: string, name: string, dataBase64: string): { path: string } {
  const ext = extname(name).slice(1).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    throw new UploadError(
      400,
      "bad_request",
      `unsupported image extension ".${ext}" — supported: ${[...IMAGE_EXTENSIONS].join(", ")}`,
    );
  }
  // Tolerate a data-URL prefix ("data:image/png;base64,....").
  const b64 = dataBase64.replace(/^data:[^,]*,/, "");
  const data = Buffer.from(b64, "base64");
  if (data.length === 0) {
    throw new UploadError(400, "bad_request", "dataBase64 is empty or not valid base64");
  }
  if (data.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(413, "too_large", `image exceeds ${MAX_UPLOAD_BYTES} bytes after decoding`);
  }
  const stamp = `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  const rel = `.seekforge/uploads/img-${stamp}.${ext}`;
  mkdirSync(join(root, ".seekforge", "uploads"), { recursive: true });
  writeFileSync(join(root, rel), data);
  return { path: rel };
}

/** Raw-file read failure carrying the HTTP status/code to respond with. */
export class RawFileError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RawFileError";
  }
}

/**
 * Reads an agent-uploaded image for GET /api/raw. Hard-confined: the
 * workspace-relative `path` must resolve to a real file *inside*
 * `.seekforge/uploads/` of `root` (no traversal, no symlink escape, no other
 * directory) and carry an image extension. This is deliberately NOT a general
 * file-serving endpoint.
 *
 * Errors: 400 `bad_request` (escaping/outside-uploads path), 415
 * `unsupported_media_type` (non-image extension), 404 `not_found` (missing or
 * not a regular file), 413 `too_large` (over MAX_RAW_BYTES).
 */
export function readRawUpload(root: string, path: string): { data: Buffer; contentType: string } {
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    throw new RawFileError(400, "bad_request", "path is required");
  }
  // Resolve against the workspace and verify it stays inside it.
  const resolved = resolve(root, path);
  const rel = relative(resolve(root), resolved);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new RawFileError(400, "bad_request", "path escapes the workspace");
  }
  // Restrict to the uploads subtree (normalized "/"-separated rel path).
  const relPosix = rel.split(/[/\\]/).join("/");
  if (!relPosix.startsWith(UPLOADS_PREFIX)) {
    throw new RawFileError(400, "bad_request", `path must be under ${UPLOADS_PREFIX}`);
  }
  const ext = extname(resolved).slice(1).toLowerCase();
  const contentType = RAW_CONTENT_TYPES[ext];
  if (!contentType) {
    throw new RawFileError(
      415,
      "unsupported_media_type",
      `unsupported image extension ".${ext}" — supported: ${Object.keys(RAW_CONTENT_TYPES).join(", ")}`,
    );
  }
  let stat: ReturnType<typeof statSync>;
  let real: string;
  try {
    stat = statSync(resolved);
    // Resolve symlinks and re-check confinement so a link inside uploads/
    // can't point at a file outside the workspace's uploads subtree.
    real = realpathSync(resolved);
  } catch {
    throw new RawFileError(404, "not_found", "file not found");
  }
  if (!stat.isFile()) {
    throw new RawFileError(404, "not_found", "file not found");
  }
  // Compare against the workspace's realpath too: the root itself may live
  // under a symlinked prefix (e.g. macOS /var -> /private/var), which would
  // otherwise make every realpath look like it escaped.
  let realRoot: string;
  try {
    realRoot = realpathSync(resolve(root));
  } catch {
    realRoot = resolve(root);
  }
  const realRel = relative(realRoot, real).split(/[/\\]/).join("/");
  if (realRel.startsWith("..") || isAbsolute(realRel) || !realRel.startsWith(UPLOADS_PREFIX)) {
    throw new RawFileError(400, "bad_request", "path escapes the uploads directory");
  }
  if (stat.size > MAX_RAW_BYTES) {
    throw new RawFileError(413, "too_large", `file exceeds ${MAX_RAW_BYTES} bytes`);
  }
  return { data: readFileSync(real), contentType };
}

// --- File browser / viewer / editor (GET /api/tree, /api/file, PUT /api/file) ---

/** Browser/viewer/editor failure carrying the HTTP status/code to respond with. */
export class FileBrowseError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "FileBrowseError";
  }
}

/** Read cap for GET /api/file; past this `truncated` is true. */
export const MAX_FILE_BYTES = 1_000_000;

export type TreeEntry = { name: string; path: string; type: "file" | "dir" };
export type Tree = { path: string; entries: TreeEntry[] };

/**
 * Resolves a workspace-relative path, asserting containment (no traversal /
 * symlink escape) and rejecting denylisted/.git paths. Throws FileBrowseError
 * with a 400 on any violation.
 */
function resolveBrowsePath(workspace: string, rel: string): string {
  if (typeof rel !== "string" || rel.includes("\0")) {
    throw new FileBrowseError(400, "bad_request", "invalid path");
  }
  let resolved: string;
  try {
    resolved = resolveInsideWorkspace(workspace, rel);
  } catch {
    throw new FileBrowseError(400, "bad_request", "path escapes the workspace");
  }
  const wsReal = realpathSync(resolve(workspace));
  const relPosix = relative(wsReal, resolved).split(/[/\\]/).join("/");
  // Reject .git anywhere in the path, denylisted directory names, and
  // sensitive basenames (.env, *.key, *.pem, ...).
  const parts = relPosix === "" ? [] : relPosix.split("/");
  for (const part of parts) {
    if (part === ".git" || DEFAULT_IGNORE_DIRS.has(part)) {
      throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
    }
  }
  if (parts.length > 0 && isSensitiveBasename(parts[parts.length - 1]!)) {
    throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
  }
  return resolved;
}

/**
 * Lists a single directory for the file browser. `rel` empty = workspace root.
 * Directories first, then files, each alphabetical. Hides .git, denylisted
 * directories, dot-directories, sensitive files, and symlinks.
 */
export function listTree(workspace: string, rel: string): Tree {
  const dir = resolveBrowsePath(workspace, rel);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dir);
  } catch {
    throw new FileBrowseError(404, "not_found", "directory not found");
  }
  if (!stat.isDirectory()) {
    throw new FileBrowseError(400, "bad_request", "path is not a directory");
  }
  const wsReal = realpathSync(resolve(workspace));
  const relRoot = relative(wsReal, dir).split(/[/\\]/).join("/");
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new FileBrowseError(404, "not_found", "directory not readable");
  }
  const dirs: TreeEntry[] = [];
  const files: TreeEntry[] = [];
  for (const ent of dirents) {
    if (ent.isSymbolicLink()) continue;
    const childRel = relRoot === "" ? ent.name : `${relRoot}/${ent.name}`;
    if (ent.isDirectory()) {
      if (ent.name === ".git" || ent.name.startsWith(".") || DEFAULT_IGNORE_DIRS.has(ent.name)) continue;
      dirs.push({ name: ent.name, path: childRel, type: "dir" });
    } else if (ent.isFile()) {
      if (isSensitiveBasename(ent.name)) continue;
      files.push({ name: ent.name, path: childRel, type: "file" });
    }
  }
  const byName = (a: TreeEntry, b: TreeEntry) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  dirs.sort(byName);
  files.sort(byName);
  return { path: relRoot, entries: [...dirs, ...files] };
}

/** Heuristic: a NUL byte in the leading bytes marks the file as binary. */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return sample.includes(0);
}

export type FileView = { path: string; content: string; truncated: boolean };

/**
 * Reads a text file for the viewer/editor. Rejects denylisted/binary files
 * with a 400. Content is capped at ~1 MB (truncated:true past the cap).
 */
export function readTextFile(workspace: string, rel: string): FileView {
  const resolved = resolveBrowsePath(workspace, rel);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    throw new FileBrowseError(404, "not_found", "file not found");
  }
  if (!stat.isFile()) {
    throw new FileBrowseError(400, "bad_request", "path is not a file");
  }
  const buf = readFileSync(resolved);
  if (looksBinary(buf)) {
    throw new FileBrowseError(400, "bad_request", "file is binary, not text");
  }
  const wsReal = realpathSync(resolve(workspace));
  const relPosix = relative(wsReal, resolved).split(/[/\\]/).join("/");
  if (buf.length > MAX_FILE_BYTES) {
    return { path: relPosix, content: buf.subarray(0, MAX_FILE_BYTES).toString("utf8"), truncated: true };
  }
  return { path: relPosix, content: buf.toString("utf8"), truncated: false };
}

/**
 * Writes a text file from the editor. Containment + denylist enforced; parent
 * directories are created. Refuses .git and sensitive paths.
 */
export function writeTextFile(workspace: string, rel: string, content: string): void {
  const resolved = resolveBrowsePath(workspace, rel);
  // resolveBrowsePath already rejects .git / sensitive basenames; double-check
  // the basename in case rel was empty (root) which has no basename.
  if (basename(resolved) === "" || resolved === realpathSync(resolve(workspace))) {
    throw new FileBrowseError(400, "bad_request", "invalid file path");
  }
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf8");
}
