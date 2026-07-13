/**
 * Workspace file index + image uploads for the web composer (SERVER-API.md):
 * GET /api/files (the @ file picker) and POST /api/upload (image paste/drop).
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeSync,
  writeFileSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
 * DEFAULT_IGNORE_DIRS members, dot-directories, and symlinks. `truncated` is
 * true when the limit cut the scan short. Reads directories asynchronously,
 * yielding to the event loop periodically so walking a large tree never
 * starves other requests.
 */
const LIST_YIELD_EVERY = 50;

async function walkWorkspaceFiles(root: string, limit: number): Promise<FileList> {
  const files: string[] = [];
  const queue: string[] = [""]; // workspace-relative directories
  let processed = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (++processed % LIST_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
    let entries: Dirent[];
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
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
        if (files.length >= limit) return { files, truncated: true };
        files.push(childRel);
      }
    }
  }
  return { files, truncated: false };
}

/** One cached (unfiltered) walk of a workspace root; `ts` = when it was taken. */
type FilesCacheEntry = { ts: number; files: string[]; truncated: boolean };

/**
 * GET /api/files is called per keystroke of the @ file picker, and each call
 * used to re-walk the whole tree. The UNFILTERED walk is memoized per
 * workspace root for a short TTL; the `q` filter runs over the cached list.
 * 3s absorbs a typing burst yet is short enough that newly created files show
 * up almost immediately. searchWorkspaceContent reuses the same cache via
 * listWorkspaceFiles.
 */
const FILES_CACHE_TTL_MS = 3_000;
const filesCache = new Map<string, FilesCacheEntry>();

/** Test hook: drops every cached walk (fixtures that create files mid-test). */
export function clearFilesCacheForTests(): void {
  filesCache.clear();
}

/**
 * Ignore-aware file index of the workspace (see walkWorkspaceFiles for scan
 * semantics), served from the per-root TTL cache. `q` is a case-insensitive
 * substring filter on the relative path; `truncated` is true when either the
 * underlying walk hit its cap or the filtered list was cut at `limit`.
 */
export async function listWorkspaceFiles(
  root: string,
  q = "",
  limit = FILE_LIST_LIMIT,
): Promise<FileList> {
  let entry = filesCache.get(root);
  if (!entry || Date.now() - entry.ts >= FILES_CACHE_TTL_MS) {
    entry = { ts: Date.now(), ...(await walkWorkspaceFiles(root, FILE_LIST_LIMIT)) };
    filesCache.set(root, entry);
  }
  // A truncated cache can't serve a limit beyond its own cap — re-walk without
  // caching. (No current caller asks for more than FILE_LIST_LIMIT.)
  if (limit > FILE_LIST_LIMIT && entry.truncated) {
    return walkWorkspaceFiles(root, limit);
  }
  const needle = q.toLowerCase();
  const matched =
    needle === "" ? entry.files : entry.files.filter((f) => f.toLowerCase().includes(needle));
  return matched.length > limit
    ? { files: matched.slice(0, limit), truncated: true }
    : { files: matched, truncated: entry.truncated };
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
    if (ch === "?" && pattern[i - 1] === "(") continue; // Group prefix: (?:...), (?=...), etc.
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

/**
 * Content search across the workspace (the @-picker's ignore-aware file set):
 * literal or regex, case-insensitive by default. Records the first non-empty
 * match per line (with its column + length). Bounded on every axis — files,
 * file size (checked via stat before reading), total hits, and a wall-clock
 * budget — and reads asynchronously, yielding to the event loop so a big search
 * never blocks other requests. Regex mode skips very long lines and is
 * conservatively validated before execution to reject backtracking-heavy
 * constructs. An invalid or unsafe regex returns `error`.
 */
export async function searchWorkspaceContent(
  root: string,
  q: string,
  opts: SearchOptions = {},
): Promise<SearchResult> {
  if (q === "") return { hits: [], truncated: false };
  const limit = opts.limit ?? SEARCH_MAX_HITS;
  const flags = opts.caseSensitive ? "" : "i";
  if (opts.regex && !isConservativeRegex(q)) {
    return { hits: [], truncated: false, error: "unsafe regex" };
  }
  let re: RegExp;
  try {
    re = new RegExp(opts.regex ? q : escapeRegExp(q), flags);
  } catch {
    return { hits: [], truncated: false, error: "invalid regex" };
  }
  // Served from the per-root TTL cache (listWorkspaceFiles) — a burst of
  // searches shares one walk with the @ file picker.
  const { files, truncated: listTruncated } = await listWorkspaceFiles(root, "", SEARCH_MAX_FILES);
  const hits: SearchHit[] = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let rootReal: string;
  try {
    rootReal = await realpath(resolve(root));
  } catch {
    return { hits, truncated: listTruncated };
  }
  let scanned = 0;
  for (const rel of files) {
    if (Date.now() > deadline) return { hits, truncated: true };
    if (++scanned % SEARCH_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
    const target = resolve(rootReal, rel);
    const fromRoot = relative(rootReal, target);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) continue;
    let physical: string;
    try {
      physical = await realpath(target);
    } catch {
      continue;
    }
    // Cached paths are untrusted at use time: a listed directory may have been
    // replaced by a symlink since the walk. Requiring the canonical path to
    // equal the expected physical path rejects both symlinks and escapes.
    if (physical !== target) continue;
    let buf: Buffer;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) continue; // size-gate BEFORE reading
      buf = await handle.readFile();
    } catch {
      continue;
    } finally {
      await handle?.close();
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if ((i & 0x3ff) === 0 && Date.now() > deadline) return { hits, truncated: true };
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
  let uploadDir: string;
  let target: string;
  try {
    uploadDir = resolveInsideWorkspace(root, ".seekforge/uploads");
  } catch {
    throw new UploadError(400, "bad_request", "upload path escapes the workspace");
  }
  mkdirSync(uploadDir, { recursive: true });
  try {
    target = resolveInsideWorkspace(root, rel);
  } catch {
    throw new UploadError(400, "bad_request", "upload path escapes the workspace");
  }
  writeFileSync(target, data);
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
  let physical: string;
  try {
    physical = resolveInsideWorkspace(workspace, rel);
  } catch {
    throw new FileBrowseError(400, "bad_request", "path escapes the workspace");
  }
  const wsReal = realpathSync(resolve(workspace));
  const resolved = resolve(wsReal, rel);
  if (physical !== resolved) {
    throw new FileBrowseError(400, "bad_request", "path contains a symbolic link");
  }
  const relPosix = relative(wsReal, resolved).split(/[/\\]/).join("/");
  // Reject .git anywhere in the path, denylisted directory names, and
  // sensitive basenames (.env, *.key, *.pem, ...).
  const parts = relPosix === "" ? [] : relPosix.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === ".git" || DEFAULT_IGNORE_DIRS.has(part)) {
      throw new FileBrowseError(400, "bad_request", `path is not browsable: ${rel}`);
    }
    // Hidden directories are not browsable — mirrors listTree, and keeps
    // .seekforge/config.json (plaintext API key) and other dot-dir contents
    // out of read/write reach. A leaf dotfile (.gitignore) is still allowed;
    // sensitive basenames are filtered below.
    if (i < parts.length - 1 && part.startsWith(".")) {
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

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function verifyOpenedPath(
  path: string,
  parentFd: number,
  fileFd: number,
): Stats {
  const parent = dirname(path);
  let parentPathStat: Stats;
  let filePathStat: Stats;
  try {
    if (realpathSync(parent) !== parent || realpathSync(path) !== path) throw new Error("swapped path");
    parentPathStat = statSync(parent);
    filePathStat = statSync(path);
  } catch {
    throw new FileBrowseError(400, "bad_request", "file path changed while opening");
  }
  const fileStat = fstatSync(fileFd);
  if (!sameFile(fstatSync(parentFd), parentPathStat) || !sameFile(fileStat, filePathStat)) {
    throw new FileBrowseError(400, "bad_request", "file path changed while opening");
  }
  return fileStat;
}

function openVerifiedFile(
  path: string,
  flags: number,
): { parentFd: number; fileFd: number; stat: Stats } {
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(path, flags | constants.O_NOFOLLOW);
    const stat = verifyOpenedPath(path, parentFd, fileFd);
    return { parentFd, fileFd, stat };
  } catch (err) {
    if (fileFd !== undefined) closeSync(fileFd);
    if (parentFd !== undefined) closeSync(parentFd);
    throw err;
  }
}

/**
 * Reads a text file for the viewer/editor. Rejects denylisted/binary files
 * with a 400. Content is capped at ~1 MB (truncated:true past the cap).
 */
export function readTextFile(workspace: string, rel: string): FileView {
  const resolved = resolveBrowsePath(workspace, rel);
  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved, constants.O_RDONLY);
  } catch (err) {
    if (err instanceof FileBrowseError) throw err;
    throw new FileBrowseError(404, "not_found", "file not found");
  }
  try {
    if (!opened.stat.isFile()) {
      throw new FileBrowseError(400, "bad_request", "path is not a file");
    }
    const truncated = opened.stat.size > MAX_FILE_BYTES;
    const length = Math.min(opened.stat.size, MAX_FILE_BYTES);
    const buf = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = readSync(opened.fileFd, buf, bytesRead, length - bytesRead, bytesRead);
      if (read === 0) break;
      bytesRead += read;
    }
    const content = buf.subarray(0, bytesRead);
    if (looksBinary(content)) {
      throw new FileBrowseError(400, "bad_request", "file is binary, not text");
    }
    const wsReal = realpathSync(resolve(workspace));
    const relPosix = relative(wsReal, resolved).split(/[/\\]/).join("/");
    return { path: relPosix, content: content.toString("utf8"), truncated };
  } finally {
    closeSync(opened.fileFd);
    closeSync(opened.parentFd);
  }
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
  let opened: ReturnType<typeof openVerifiedFile>;
  try {
    opened = openVerifiedFile(resolved, constants.O_WRONLY | constants.O_CREAT);
  } catch (err) {
    if (err instanceof FileBrowseError) throw err;
    throw new FileBrowseError(400, "bad_request", "file not writable");
  }
  try {
    if (!opened.stat.isFile()) {
      throw new FileBrowseError(400, "bad_request", "path is not a file");
    }
    const data = Buffer.from(content, "utf8");
    ftruncateSync(opened.fileFd, 0);
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(opened.fileFd, data, offset, data.length - offset, offset);
      if (written === 0) throw new FileBrowseError(500, "write_failed", "file write made no progress");
      offset += written;
    }
  } finally {
    closeSync(opened.fileFd);
    closeSync(opened.parentFd);
  }
}
