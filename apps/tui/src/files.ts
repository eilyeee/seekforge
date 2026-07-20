/**
 * Workspace file index + frecency for the @ file picker. The scan is a BFS
 * so shallow files surface first (the most likely @-targets), skipping the
 * same directories the tools ignore plus any dot-directory and symlinks.
 * Frecency (frequency + recency, à la DeepSeek-TUI file_frecency) persists
 * to .seekforge/tui-frecency.json so repeat picks bubble to the top.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_IGNORE_DIRS } from "@seekforge/core";
import { fuzzyScore } from "./fuzzy.js";
import { readStateFile, writeStateFile } from "./state-file.js";

const DEFAULT_SCAN_LIMIT = 5000;
const MAX_FRECENCY_ENTRIES = 500;
const DEFAULT_RANK_LIMIT = 10;

/**
 * BFS over the workspace: shallow files first, workspace-relative paths with
 * "/" separators. Skips DEFAULT_IGNORE_DIRS members, dot-directories, and
 * symlinks; stops at `limit` files (default 5000).
 */
export function scanWorkspaceFiles(root: string, opts?: { limit?: number }): string[] {
  const limit = opts?.limit ?? DEFAULT_SCAN_LIMIT;
  const files: string[] = [];
  const queue: string[] = [""]; // workspace-relative directories
  while (queue.length > 0 && files.length < limit) {
    const rel = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
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
        files.push(childRel);
        if (files.length >= limit) break;
      }
    }
  }
  return files;
}

export type Frecency = Record<string, { count: number; last: number }>;

function frecencyFile(root: string): string {
  return path.join(root, ".seekforge", "tui-frecency.json");
}

/** Loads <root>/.seekforge/tui-frecency.json; {} when missing or corrupt. */
export function loadFrecency(root: string): Frecency {
  try {
    const parsed: unknown = JSON.parse(readStateFile(frecencyFile(root)));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Frecency = {};
    for (const [key, value] of Object.entries(parsed)) {
      const v = value as { count?: unknown; last?: unknown };
      if (
        typeof v?.count === "number" &&
        Number.isSafeInteger(v.count) &&
        v.count >= 0 &&
        typeof v?.last === "number" &&
        Number.isFinite(v.last) &&
        v.last >= 0
      ) {
        out[key] = { count: v.count, last: v.last };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Bumps a picked path (count+1, last=now), keeping at most 500 entries. */
export function bumpFrecency(root: string, filePath: string): void {
  const frecency = loadFrecency(root);
  const prev = frecency[filePath];
  frecency[filePath] = { count: Math.min(Number.MAX_SAFE_INTEGER, (prev?.count ?? 0) + 1), last: Date.now() };
  let entries = Object.entries(frecency);
  if (entries.length > MAX_FRECENCY_ENTRIES) {
    entries.sort((a, b) => b[1].last - a[1].last); // most recent first
    entries = entries.slice(0, MAX_FRECENCY_ENTRIES);
  }
  const file = frecencyFile(root);
  writeStateFile(file, JSON.stringify(Object.fromEntries(entries)));
}

/**
 * Ranks files for the picker. Empty query: frecency'd files first (count
 * desc, then last desc), then the rest in scan order. Non-empty: fuzzy
 * score plus a small log-scaled frecency boost so habitual picks win ties.
 */
export function rankFiles(
  query: string,
  files: readonly string[],
  frecency: Frecency,
  limit = DEFAULT_RANK_LIMIT,
): string[] {
  if (query === "") {
    const known = files.filter((f) => frecency[f] !== undefined);
    known.sort((a, b) => {
      const fa = frecency[a] as { count: number; last: number };
      const fb = frecency[b] as { count: number; last: number };
      return fb.count - fa.count || fb.last - fa.last;
    });
    const rest = files.filter((f) => frecency[f] === undefined);
    return [...known, ...rest].slice(0, limit);
  }
  const scored: Array<{ file: string; score: number; order: number }> = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i] as string;
    const base = fuzzyScore(query, file);
    if (base === null) continue;
    const boost = Math.log1p(frecency[file]?.count ?? 0);
    scored.push({ file, score: base + boost, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.file);
}
