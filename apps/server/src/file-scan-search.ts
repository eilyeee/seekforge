import { constants, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { DEFAULT_IGNORE_DIRS } from "@seekforge/core";
import {
  closeVerifiedFileAsync,
  openVerifiedFileAsync,
  revalidateOpenedFileAsync,
  resolveWorkspacePath,
} from "./file-security.js";

/** Hard cap on the number of paths GET /api/files returns. */
export const FILE_LIST_LIMIT = 2000;

export type FileList = { files: string[]; truncated: boolean };

const LIST_YIELD_EVERY = 50;

async function walkWorkspaceFiles(root: string, limit: number): Promise<FileList> {
  const files: string[] = [];
  const queue: string[] = [""];
  let processed = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (++processed % LIST_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
    let entries: Dirent[];
    let opened: Awaited<ReturnType<typeof openVerifiedFileAsync>> | undefined;
    try {
      const directory = resolveWorkspacePath(root, rel, true).path;
      opened = await openVerifiedFileAsync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      entries = await readdir(directory, { withFileTypes: true });
      await revalidateOpenedFileAsync(directory, opened);
    } catch {
      continue;
    } finally {
      if (opened) await closeVerifiedFileAsync(opened);
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

type FilesCacheEntry = { ts: number; files: string[]; truncated: boolean };

const FILES_CACHE_TTL_MS = 3_000;
const filesCache = new Map<string, FilesCacheEntry>();

/** Test hook: drops every cached walk (fixtures that create files mid-test). */
export function clearFilesCacheForTests(): void {
  filesCache.clear();
}

export async function listWorkspaceFiles(root: string, q = "", limit = FILE_LIST_LIMIT): Promise<FileList> {
  let entry = filesCache.get(root);
  if (!entry || Date.now() - entry.ts >= FILES_CACHE_TTL_MS) {
    entry = { ts: Date.now(), ...(await walkWorkspaceFiles(root, FILE_LIST_LIMIT)) };
    filesCache.set(root, entry);
  }
  if (limit > FILE_LIST_LIMIT && entry.truncated) {
    const expanded = await walkWorkspaceFiles(root, limit);
    const needle = q.toLowerCase();
    const matched = needle === "" ? expanded.files : expanded.files.filter((f) => f.toLowerCase().includes(needle));
    return matched.length > limit
      ? { files: matched.slice(0, limit), truncated: true }
      : { files: matched, truncated: expanded.truncated };
  }
  const needle = q.toLowerCase();
  const matched = needle === "" ? entry.files : entry.files.filter((f) => f.toLowerCase().includes(needle));
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
const SEARCH_BUDGET_MS = 3000;
const SEARCH_MAX_REGEX_LINE = 2000;
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

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, Math.min(buf.length, 8000)).includes(0);
}

export async function searchWorkspaceContent(root: string, q: string, opts: SearchOptions = {}): Promise<SearchResult> {
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
  const { files, truncated: listTruncated } = await listWorkspaceFiles(root, "", SEARCH_MAX_FILES);
  const hits: SearchHit[] = [];
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  let scanned = 0;
  for (const rel of files) {
    if (Date.now() > deadline) return { hits, truncated: true };
    if (++scanned % SEARCH_YIELD_EVERY === 0) await new Promise<void>((r) => setImmediate(r));
    let opened: Awaited<ReturnType<typeof openVerifiedFileAsync>> | undefined;
    try {
      const resolved = resolveWorkspacePath(root, rel, true);
      opened = await openVerifiedFileAsync(resolved.path, constants.O_RDONLY);
      if (!opened.stat.isFile() || opened.stat.size > SEARCH_MAX_FILE_BYTES) continue;
      const buf = await opened.fileHandle.readFile();
      if (looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if ((i & 0x3ff) === 0 && Date.now() > deadline) return { hits, truncated: true };
        const line = lines[i] as string;
        if (opts.regex && line.length > SEARCH_MAX_REGEX_LINE) continue;
        const match = re.exec(line);
        if (match && match[0].length > 0) {
          hits.push({
            path: rel,
            line: i + 1,
            text: line.slice(0, SEARCH_MAX_LINE_LEN),
            col: match.index,
            len: match[0].length,
          });
          if (hits.length >= limit) return { hits, truncated: true };
        }
      }
    } catch {
    } finally {
      if (opened) await closeVerifiedFileAsync(opened);
    }
  }
  return { hits, truncated: listTruncated };
}
