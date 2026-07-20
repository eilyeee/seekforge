/**
 * Parked-draft stash (/stash, cf. DeepSeek-TUI composer_stash). A side
 * channel from history: drafts the user parked deliberately, popped back
 * LIFO. Stored as a plain JSON string array at .seekforge/stash.json —
 * JSON escapes newlines, so multiline drafts round-trip intact. Capped at
 * 20 entries (oldest pruned at push time); corrupt files read as empty.
 */

import * as path from "node:path";
import { readStateFile, writeStateFile } from "./state-file.js";

const MAX_STASH_ENTRIES = 20;

function stashFile(workspace: string): string {
  return path.join(workspace, ".seekforge", "stash.json");
}

/** All stashed drafts, oldest first. [] when missing or corrupt. */
export function stashList(workspace: string): string[] {
  let raw: string;
  try {
    raw = readStateFile(stashFile(workspace));
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string" && e !== "");
  } catch {
    return []; // corrupt file — treat as empty rather than crash
  }
}

function writeStash(workspace: string, entries: readonly string[]): void {
  const file = stashFile(workspace);
  writeStateFile(file, JSON.stringify(entries, null, 1));
}

/**
 * Parks a draft and returns the resulting stash size. Whitespace-only
 * drafts are dropped (a stray /stash on an empty composer is a no-op);
 * the oldest entries are pruned past the 20-entry cap.
 */
export function stashPush(workspace: string, draft: string): number {
  const entries = stashList(workspace);
  if (draft.trim() === "") return entries.length;
  entries.push(draft);
  const kept = entries.slice(-MAX_STASH_ENTRIES);
  writeStash(workspace, kept);
  return kept.length;
}

/** Removes and returns the most recently parked draft (LIFO); null when empty. */
export function stashPop(workspace: string): string | null {
  const entries = stashList(workspace);
  const popped = entries.pop();
  if (popped === undefined) return null;
  writeStash(workspace, entries);
  return popped;
}
