/**
 * Fetching a plugin (or marketplace) from somewhere other than a local
 * directory: a shallow git clone or an https archive, staged into a private
 * directory that the caller then validates and installs.
 *
 * Nothing staged here is trusted. The only thing this module promises is that
 * the staged tree is a plain directory produced without a shell, without git
 * transports that execute commands, and — for archives — only after every
 * member was checked to be a regular file or directory at a confined relative
 * path. Content review is still the digest-approval flow's job: an install
 * always lands disabled.
 *
 * Archive extraction is delegated to the system `tar` / `unzip`, so the checks
 * below are what stand between a hostile archive and those tools:
 *   - gzip is inflated in-process with a hard output cap, so `tar` only ever
 *     sees a bounded, uncompressed file (no decompression bomb reaches disk);
 *   - tar and zip member tables are parsed here, and anything that is not a
 *     regular file or directory (symlinks, hard links, devices, FIFOs), any
 *     absolute or `..` path, set-id bits, encryption and zip64 are refused;
 *   - the tool's own listing must agree with that parse (entry count, and the
 *     names wherever they are plain ASCII), so a member this parser misread
 *     cannot be extracted under a different name;
 *   - after extraction the installer's digest walk rejects any link or special
 *     file that still appeared, and bounds the file count and total size.
 * Residual risk: a zip member's declared size is what the cap checks; `unzip`
 * detects a size/CRC mismatch only after inflating that member, so a lying
 * archive can still spend disk space (bounded by the extraction timeout)
 * before the install fails and the staging directory is removed.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { seekforgeHome } from "../memory/store.js";
import { readResponseBody } from "../util/response-body.js";
import { PLUGIN_ID_RE, resolvePluginStateDir } from "./load.js";

/** What a user-typed plugin source names. */
export type PluginSourceSpec =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "archive"; url: string; format: ArchiveFormat }
  | { kind: "marketplace"; plugin: string; marketplace: string };

export type ArchiveFormat = "tar.gz" | "zip";

export const MAX_PLUGIN_ARCHIVE_BYTES = 20 * 1024 * 1024;
/** Uncompressed tar / declared zip content; comfortably above the 10 MiB install cap plus headers. */
export const MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4_000;
const MAX_REDIRECTS = 5;
const GIT_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const GIT_REF_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/+-]{1,200}$/;
const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** `user@host:path` — git's SCP-like syntax. A user part is required so `C:\dir` is never taken for one. */
const SCP_GIT_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9][A-Za-z0-9.-]*:(?!\/\/)[A-Za-z0-9._~/-]+$/;
const ARCHIVE_SUFFIXES: Array<[string, ArchiveFormat]> = [
  [".tar.gz", "tar.gz"],
  [".tgz", "tar.gz"],
  [".zip", "zip"],
];

function archiveFormatOf(url: URL): ArchiveFormat | undefined {
  const pathname = url.pathname.toLowerCase();
  return ARCHIVE_SUFFIXES.find(([suffix]) => pathname.endsWith(suffix))?.[1];
}

export function validateGitRef(ref: string): string {
  if (!GIT_REF_RE.test(ref)) throw new Error(`invalid git ref: ${JSON.stringify(ref)}`);
  return ref;
}

export function validateGitSha(sha: string): string {
  if (!GIT_SHA_RE.test(sha)) throw new Error(`invalid git commit sha (expected 40 or 64 hex digits): ${sha}`);
  return sha;
}

/**
 * Classify a git or archive URL. `forceGit` treats an archive-looking https URL
 * as a repository (a marketplace entry that says `source: "git"`).
 */
export function classifyRemoteUrl(
  raw: string,
  opts: { forceGit?: boolean } = {},
): Extract<PluginSourceSpec, { kind: "git" | "archive" }> {
  if (raw.startsWith("-")) throw new Error(`plugin source must not start with "-": ${raw}`);
  if (SCP_GIT_RE.test(raw.split("#")[0]!)) {
    const [url, ref] = splitRef(raw);
    return { kind: "git", url, ...(ref !== undefined ? { ref } : {}) };
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase();
  if (scheme === undefined) throw new Error(`not a git or archive URL: ${raw}`);
  if (scheme === "http" || scheme === "git") {
    throw new Error(`refusing unencrypted ${scheme}:// plugin source; use https:// or ssh:// (${raw})`);
  }
  if (scheme !== "https" && scheme !== "ssh" && scheme !== "file") {
    throw new Error(`unsupported plugin source scheme "${scheme}": use https://, ssh://, git@host:path or file://`);
  }
  const [url, ref] = splitRef(raw);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid plugin source URL: ${raw}`);
  }
  const format = scheme === "https" && opts.forceGit !== true ? archiveFormatOf(parsed) : undefined;
  if (format !== undefined) {
    if (ref !== undefined) throw new Error(`an archive URL takes no #ref: ${raw}`);
    return { kind: "archive", url: parsed.href, format };
  }
  return { kind: "git", url, ...(ref !== undefined ? { ref } : {}) };
}

function splitRef(raw: string): [string, string | undefined] {
  const hash = raw.lastIndexOf("#");
  if (hash === -1) return [raw, undefined];
  const ref = raw.slice(hash + 1);
  if (ref === "") throw new Error(`empty #ref in plugin source: ${raw}`);
  return [raw.slice(0, hash), validateGitRef(ref)];
}

/**
 * Classify what a user typed after `plugin install`. An existing path always
 * wins, so a local directory that happens to be named `a@b` stays installable;
 * `exists` is injectable so the syntax rules can be tested without a disk.
 */
export function classifyPluginSource(
  spec: string,
  opts: { cwd?: string; exists?: (path: string) => boolean } = {},
): PluginSourceSpec {
  const trimmed = spec.trim();
  if (trimmed === "") throw new Error("plugin source is empty");
  if (trimmed.startsWith("-")) throw new Error(`plugin source must not start with "-": ${trimmed}`);
  const exists = opts.exists ?? existsSync;
  const local = resolve(opts.cwd ?? process.cwd(), trimmed);
  const looksLikeUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) || /^[A-Za-z][A-Za-z0-9+.-]*::/.test(trimmed);
  if (!looksLikeUrl && exists(local)) return { kind: "local", path: local };
  if (looksLikeUrl || SCP_GIT_RE.test(trimmed.split("#")[0]!)) return classifyRemoteUrl(trimmed);
  const at = trimmed.indexOf("@");
  if (at > 0 && at === trimmed.lastIndexOf("@")) {
    const plugin = trimmed.slice(0, at);
    const marketplace = trimmed.slice(at + 1);
    if (PLUGIN_ID_RE.test(plugin) && PLUGIN_ID_RE.test(marketplace)) {
      return { kind: "marketplace", plugin, marketplace };
    }
  }
  return { kind: "local", path: local };
}

/** The URL as recorded in state and printed: credentials never leave the command line. */
export function redactSourceUrl(url: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)) return url;
  try {
    const parsed = new URL(url);
    if (parsed.username === "" && parsed.password === "") return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

export class PluginToolMissingError extends Error {
  constructor(tool: string, cause: unknown) {
    super(
      `${tool} is required for this plugin source but could not be started: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "PluginToolMissingError";
  }
}

type ToolRun = {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBuffer?: number;
  label?: string;
  /** Extra environment. tar/unzip keep the user's locale so UTF-8 member names survive. */
  env?: Record<string, string>;
};

/**
 * Run a tool without a shell. A spawn failure (the binary is missing) keeps its
 * original error; a clean non-zero exit is reported with its code. Neither is
 * classified by the tool's (possibly localized) message text.
 */
export function runTool(command: string, args: string[], opts: ToolRun): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        signal: opts.signal,
        env: { ...process.env, ...opts.env },
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(stdout);
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EACCES") {
          reject(new PluginToolMissingError(command, error));
          return;
        }
        if (error.name === "AbortError") {
          reject(error);
          return;
        }
        const exit = typeof code === "number" ? `exit ${code}` : error.killed ? "timed out" : String(code ?? "failed");
        const detail = String(stderr || stdout || "")
          .trim()
          .slice(-500);
        reject(new Error(`${opts.label ?? command} failed (${exit})${detail ? `: ${detail}` : ""}`));
      },
    );
  });
}

function git(args: string[], opts: Omit<ToolRun, "timeoutMs"> & { timeoutMs?: number }): Promise<string> {
  // ext:: runs an arbitrary command as a "transport"; git already refuses it by
  // default, and saying so here keeps a user's permissive config from reaching it.
  return runTool("git", ["-c", "protocol.ext.allow=never", ...args], {
    ...opts,
    timeoutMs: opts.timeoutMs ?? GIT_TIMEOUT_MS,
    label: `git ${args[0]}`,
    // Locale-independent output; credential prompts fail instead of hanging.
    env: { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Shallow-clone `url` into `target` (which must not exist), optionally pinned
 * to `sha`, and return the checked-out commit. The checkout's `.git` is removed
 * before returning: what gets reviewed and installed is the tree, not history.
 */
export async function cloneShallow(
  url: string,
  target: string,
  opts: { ref?: string; sha?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (url.startsWith("-")) throw new Error(`git URL must not start with "-": ${url}`);
  const ref = opts.ref === undefined ? undefined : validateGitRef(opts.ref);
  const sha = opts.sha === undefined ? undefined : validateGitSha(opts.sha);
  await git(
    [
      "clone",
      "--depth",
      "1",
      "--no-recurse-submodules",
      ...(ref !== undefined ? ["--branch", ref] : []),
      "--",
      url,
      target,
    ],
    { signal: opts.signal },
  );
  let head = (await git(["rev-parse", "HEAD"], { cwd: target, signal: opts.signal })).trim();
  if (sha !== undefined && head !== sha) {
    // A pinned commit need not be the tip; fetch exactly that object.
    await git(["fetch", "--depth", "1", "origin", sha], { cwd: target, signal: opts.signal });
    await git(["checkout", "--detach", "FETCH_HEAD"], { cwd: target, signal: opts.signal });
    head = (await git(["rev-parse", "HEAD"], { cwd: target, signal: opts.signal })).trim();
    if (head !== sha) throw new Error(`pinned commit ${sha} could not be checked out (got ${head})`);
  }
  if (!GIT_SHA_RE.test(head)) throw new Error(`git rev-parse returned an unexpected commit id: ${head.slice(0, 80)}`);
  rmSync(join(target, ".git"), { recursive: true, force: true });
  return head;
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * `~/.seekforge/<parent>` as a physical directory (no symlinked component
 * below the SeekForge home), created 0700 when `create` is set. Undefined when
 * it does not exist and `create` is not set.
 */
export function seekforgeStateDir(parent: "plugins" | "plugin-marketplaces", create: boolean): string | undefined {
  return resolvePluginStateDir(seekforgeHome(), parent, create);
}

/** A private, owner-only scratch directory under `~/.seekforge/<parent>/`. */
export function createStagingDir(parent: "plugins" | "plugin-marketplaces"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(seekforgeStateDir(parent, true)!, ".staging-"));
  return {
    path,
    cleanup: () => {
      // Best effort: a hidden leftover is harmless, and a cleanup failure must
      // not replace the error that made the install fail.
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // ignored
      }
    },
  };
}

/**
 * Resolve `subdir` inside `root`, refusing anything that leaves it lexically or
 * physically. Undefined, "" and "." mean the root itself.
 */
export function confinedDirectory(root: string, subdir: string | undefined, label = "plugin path"): string {
  const physicalRoot = realpathSync(root);
  if (subdir === undefined || subdir === "" || subdir === "." || subdir === "./") return physicalRoot;
  if (isAbsolute(subdir) || subdir.includes("\\") || subdir.split("/").includes("..")) {
    throw new Error(`${label} must be a relative path inside its source: ${subdir}`);
  }
  let physical: string;
  try {
    physical = realpathSync(resolve(physicalRoot, subdir));
  } catch {
    throw new Error(`${label} does not exist: ${subdir}`);
  }
  const rel = relative(physicalRoot, physical);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes its source: ${subdir}`);
  }
  if (!lstatSync(physical).isDirectory()) throw new Error(`${label} is not a directory: ${subdir}`);
  return physical;
}

function hasManifest(dir: string): boolean {
  return existsSync(join(dir, "plugin.json")) || existsSync(join(dir, ".claude-plugin", "plugin.json"));
}

/** GitHub-style tarballs wrap everything in one top-level directory. */
export function archiveContentRoot(extracted: string): string {
  if (hasManifest(extracted)) return extracted;
  const entries = readdirSync(extracted, { withFileTypes: true });
  if (entries.length === 1 && entries[0]!.isDirectory()) return join(extracted, entries[0]!.name);
  return extracted;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * GET an https URL with every redirect hop re-checked (redirects are followed
 * by hand so a hop to http:// is refused rather than silently taken), a byte
 * cap enforced while streaming, and a wall-clock timeout covering the body.
 */
export async function downloadArchive(
  url: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; maxBytes?: number } = {},
): Promise<{ body: Buffer; sha256: string; finalUrl: string }> {
  const doFetch = opts.fetch ?? fetch;
  const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let current = requireHttps(url);
  for (let redirects = 0; ; redirects++) {
    const response = await doFetch(current, { redirect: "manual", signal });
    const location = [301, 302, 303, 307, 308].includes(response.status) ? response.headers.get("location") : null;
    if (location !== null) {
      await response.body?.cancel().catch(() => undefined);
      if (redirects >= MAX_REDIRECTS) throw new Error(`plugin download exceeded ${MAX_REDIRECTS} redirects`);
      let next: string;
      try {
        next = new URL(location, current).href;
      } catch {
        throw new Error(`plugin download redirected to an invalid URL: ${location}`);
      }
      current = requireHttps(next);
      continue;
    }
    // An injected or platform fetch that followed redirects itself still has
    // to have ended on https.
    if (response.url) requireHttps(response.url);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`plugin download failed: HTTP ${response.status} for ${redactSourceUrl(current)}`);
    }
    const body = await readResponseBody(response, opts.maxBytes ?? MAX_PLUGIN_ARCHIVE_BYTES);
    return { body, sha256: createHash("sha256").update(body).digest("hex"), finalUrl: current };
  }
}

function requireHttps(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`invalid download URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`refusing a non-https plugin download: ${redactSourceUrl(parsed.href)}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(`archive URLs cannot carry credentials: ${redactSourceUrl(parsed.href)}`);
  }
  return parsed.href;
}

// ---------------------------------------------------------------------------
// Archive member tables
// ---------------------------------------------------------------------------

export type ArchiveEntry = { name: string; type: "file" | "directory"; size: number };

/** Refuse a member path that is absolute, climbs out, or would be read differently by another tool. */
export function assertSafeMemberName(name: string): void {
  if (name === "" || name.includes("\0")) throw new Error("archive contains an empty or NUL member name");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error(`archive member has an absolute path: ${name}`);
  if (name.includes("\\")) throw new Error(`archive member name contains a backslash: ${name}`);
  if (name.split("/").includes("..")) throw new Error(`archive member escapes the archive: ${name}`);
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`archive member name contains control characters`);
}

/**
 * No set-id or sticky bits, and nothing the owner cannot read (or, for a
 * directory, enter and clean up): such a tree could neither be digested nor
 * removed from staging.
 */
function assertSafeMode(name: string, kind: ArchiveEntry["type"], mode: number): void {
  if ((mode & 0o7000) !== 0) throw new Error(`archive member has set-id or sticky bits: ${name}`);
  const required = kind === "directory" ? 0o700 : 0o400;
  if ((mode & required) !== required) throw new Error(`archive member is not accessible to its owner: ${name}`);
}

function cString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return (end === -1 ? slice : slice.subarray(0, end)).toString("utf8");
}

function octal(block: Buffer, start: number, length: number, field: string): number {
  if ((block[start]! & 0x80) !== 0) throw new Error(`archive uses a base-256 ${field}, which is not supported`);
  const text = cString(block, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error(`archive has a malformed ${field}: ${JSON.stringify(text)}`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error(`archive ${field} is out of range`);
  return value;
}

function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number(data.subarray(offset, space).toString("ascii"));
    if (!Number.isSafeInteger(length) || length <= space - offset || offset + length > data.length) {
      throw new Error("archive has a malformed pax header");
    }
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq === -1) throw new Error("archive has a malformed pax record");
    records.set(record.slice(0, eq), record.slice(eq + 1));
    offset += length;
  }
  return records;
}

/**
 * Parse an uncompressed tar's member table (ustar, pax and GNU long names).
 * Only regular files and directories are accepted; the checksum of every
 * header is verified so a corrupt block cannot shift the walk.
 */
export function listTarEntries(tar: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;
  let pendingName: string | undefined;
  let pendingSize: number | undefined;
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;
    const expected = octal(block, 148, 8, "header checksum");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
    if (sum !== expected) throw new Error("archive has a corrupt tar header (checksum mismatch)");
    const type = String.fromCharCode(block[156]!);
    const headerSize = octal(block, 124, 12, "member size");
    const extension = type === "x" || type === "g" || type === "L";
    // A pax `size` describes the next real member, never another extension header.
    const size = extension ? headerSize : (pendingSize ?? headerSize);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error("archive is truncated");
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "x" || type === "g") {
      const records = paxRecords(data);
      if (type === "g") {
        if (records.has("path") || records.has("linkpath") || records.has("size")) {
          throw new Error("archive has a global pax header that renames or resizes members");
        }
        continue;
      }
      pendingName = records.get("path") ?? pendingName;
      const paxSize = records.get("size");
      if (paxSize !== undefined) {
        if (!/^\d+$/.test(paxSize) || !Number.isSafeInteger(Number(paxSize))) {
          throw new Error("archive has a malformed pax size");
        }
        pendingSize = Number(paxSize);
      }
      continue;
    }
    if (type === "L") {
      pendingName = cString(data, 0, data.length);
      continue;
    }
    const magic = block.subarray(257, 263).toString("latin1");
    const prefix = magic === "ustar\0" ? cString(block, 345, 155) : "";
    const headerName = cString(block, 0, 100);
    const name = pendingName ?? (prefix ? `${prefix}/${headerName}` : headerName);
    pendingName = undefined;
    pendingSize = undefined;
    let kind: ArchiveEntry["type"];
    if (type === "0" || type === "\0" || type === "7") kind = "file";
    else if (type === "5") kind = "directory";
    else if (type === "1" || type === "2")
      throw new Error(`archive contains a link, which plugins may not ship: ${name}`);
    else throw new Error(`archive member ${name} has unsupported type ${JSON.stringify(type)}`);
    assertSafeMode(name, kind, octal(block, 100, 8, "member mode"));
    assertSafeMemberName(name);
    entries.push({ name, type: kind, size: kind === "file" ? size : 0 });
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has more than ${MAX_ARCHIVE_ENTRIES} members`);
  }
  if (pendingName !== undefined || pendingSize !== undefined) throw new Error("archive ends inside an extended header");
  return entries;
}

/**
 * Parse a zip's central directory. Encrypted members, zip64, multi-disk
 * archives, and any Unix mode other than a regular file or directory are
 * refused.
 */
export function listZipEntries(zip: Buffer): ArchiveEntry[] {
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= floor; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip archive (no end-of-central-directory record)");
  if (zip.readUInt16LE(eocd + 4) !== 0 || zip.readUInt16LE(eocd + 6) !== 0) {
    throw new Error("multi-disk zip archives are not supported");
  }
  const count = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are not supported");
  }
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has more than ${MAX_ARCHIVE_ENTRIES} members`);
  if (cdOffset + cdSize > eocd) throw new Error("zip central directory is out of bounds");
  const entries: ArchiveEntry[] = [];
  let offset = cdOffset;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > eocd || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("zip central directory is corrupt");
    }
    const host = zip[offset + 5]!;
    const flags = zip.readUInt16LE(offset + 8);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const attributes = zip.readUInt32LE(offset + 38);
    const nameBytes = zip.subarray(offset + 46, offset + 46 + nameLength);
    const name = nameBytes.toString((flags & 0x800) !== 0 ? "utf8" : "latin1");
    const extra = zip.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > eocd) throw new Error("zip central directory is corrupt");
    // unzip prefers an Info-ZIP Unicode Path field (0x7075) over the header
    // name, so that name has to pass the same checks.
    for (let at = 0; at + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(at);
      const length = extra.readUInt16LE(at + 2);
      if (at + 4 + length > extra.length) throw new Error(`zip member has a malformed extra field: ${name}`);
      if (id === 0x7075 && length >= 5) assertSafeMemberName(extra.subarray(at + 9, at + 4 + length).toString("utf8"));
      at += 4 + length;
    }
    if ((flags & 0x1) !== 0) throw new Error(`zip member is encrypted: ${name}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff) throw new Error("zip64 archives are not supported");
    let kind: ArchiveEntry["type"] = name.endsWith("/") ? "directory" : "file";
    // Only a Unix host (3) stores a meaningful st_mode in the high attribute bits.
    const mode = host === 3 ? attributes >>> 16 : 0;
    const fileType = mode & 0o170000;
    if (fileType === 0o040000) kind = "directory";
    else if (fileType !== 0 && fileType !== 0o100000) {
      throw new Error(`archive contains a link or special file, which plugins may not ship: ${name}`);
    }
    if (mode !== 0) assertSafeMode(name, kind, mode);
    assertSafeMemberName(name);
    entries.push({ name, type: kind, size: kind === "file" ? size : 0 });
  }
  return entries;
}

function assertWithinCap(entries: ArchiveEntry[]): void {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES) {
    throw new Error(`archive expands to ${total} bytes, above the ${MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES}-byte limit`);
  }
}

/**
 * The extracting tool must see the same members this module validated. Counts
 * always have to agree; names are compared wherever both sides are printable
 * ASCII (tools escape anything else in their own ways).
 */
export function assertListingAgrees(parsed: ArchiveEntry[], listed: string[]): void {
  if (parsed.length !== listed.length) {
    throw new Error(`archive listing disagrees with its member table (${listed.length} vs ${parsed.length} entries)`);
  }
  const plain = (value: string) => /^[\x20-\x7e]*$/.test(value) && !value.includes("\\");
  parsed.forEach((entry, index) => {
    const other = listed[index]!;
    if (plain(entry.name) && plain(other) && entry.name !== other) {
      throw new Error(`archive listing disagrees with its member table at ${JSON.stringify(entry.name)}`);
    }
  });
}

function listingLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line !== "");
}

/**
 * Validate and extract an archive into `target` (created 0700). Returns the
 * validated member table.
 */
export async function extractArchive(
  body: Buffer,
  format: ArchiveFormat,
  workDir: string,
  target: string,
  signal?: AbortSignal,
): Promise<ArchiveEntry[]> {
  if (format === "tar.gz") {
    let tar: Buffer;
    try {
      tar = gunzipSync(body, { maxOutputLength: MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
        throw new Error(`archive expands beyond the ${MAX_PLUGIN_ARCHIVE_EXPANDED_BYTES}-byte limit`);
      }
      throw new Error(`archive is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = listTarEntries(tar);
    assertWithinCap(entries);
    const tarPath = join(workDir, "plugin.tar");
    writeFileSync(tarPath, tar, { mode: 0o600, flag: "wx" });
    const run = { timeoutMs: TOOL_TIMEOUT_MS, signal };
    assertListingAgrees(
      entries,
      listingLines(await runTool("tar", ["-t", "-f", tarPath], { ...run, label: "tar -t" })),
    );
    mkdirSync(target, { mode: 0o700 });
    await runTool("tar", ["-x", "-f", tarPath, "-C", target], { ...run, label: "tar -x" });
    return entries;
  }
  const entries = listZipEntries(body);
  assertWithinCap(entries);
  const zipPath = join(workDir, "plugin.zip");
  writeFileSync(zipPath, body, { mode: 0o600, flag: "wx" });
  const run = { timeoutMs: TOOL_TIMEOUT_MS, signal };
  assertListingAgrees(entries, listingLines(await runTool("unzip", ["-Z1", zipPath], { ...run, label: "unzip -Z1" })));
  mkdirSync(target, { mode: 0o700 });
  await runTool("unzip", ["-q", "-n", zipPath, "-d", target], { ...run, label: "unzip" });
  return entries;
}
