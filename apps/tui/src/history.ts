/**
 * Persisted composer history. One JSON-encoded string per line (JSONL) so
 * multiline entries survive a round-trip; capped at 200 entries so the file
 * never grows unbounded. The nav object implements readline's ↑/↓ semantics
 * including saving the in-progress draft on the first ↑.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_ENTRIES = 200;

/** Loads history oldest→newest; tolerates a missing file and corrupt lines. */
export function loadHistory(file: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "string") entries.push(parsed);
    } catch {
      // corrupt line — skip it rather than losing the whole history
    }
  }
  return entries.slice(-MAX_ENTRIES);
}

/** Appends an entry (skipping consecutive duplicates) and rewrites the file capped at 200. */
export function appendHistory(file: string, entry: string): void {
  const entries = loadHistory(file);
  if (entries[entries.length - 1] === entry) return;
  entries.push(entry);
  const kept = entries.slice(-MAX_ENTRIES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

export type HistoryNav = {
  up(draft: string): string | null;
  down(): string | null;
  reset(): void;
};

/**
 * Readline semantics: the first up() saves the draft and returns the newest
 * entry; further up() walks back (null at the oldest); down() walks forward
 * and returns the saved draft when stepping past the newest entry (null when
 * already sitting at the draft).
 */
export function createHistoryNav(entries: string[]): HistoryNav {
  let index = entries.length; // entries.length = "at the draft"
  let draft = "";
  return {
    up(current: string): string | null {
      if (entries.length === 0) return null;
      if (index === entries.length) draft = current;
      if (index === 0) return null;
      index -= 1;
      return entries[index] ?? null;
    },
    down(): string | null {
      if (index >= entries.length) return null;
      index += 1;
      if (index === entries.length) return draft;
      return entries[index] ?? null;
    },
    reset(): void {
      index = entries.length;
      draft = "";
    },
  };
}
