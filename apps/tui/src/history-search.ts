/**
 * Incremental reverse history search (bash Ctrl+R semantics). Pure functions
 * over the persisted history array (oldest→newest, what loadHistory returns):
 * the app holds a HistorySearch in state, feeds keystrokes through
 * searchInput/searchBackspace/searchNext, and renders currentMatch in the
 * composer; accepting the match is just setText(currentMatch(...)).
 */

import { previousGraphemeBoundary } from "./editor.js";

export type HistorySearch = {
  query: string;
  /** Indices into the entries array (newest-first order of matching), or empty. */
  matches: number[];
  /** Position within matches currently shown. */
  cursor: number;
};

/** A fresh search: empty query, no matches. */
export function startSearch(): HistorySearch {
  return { query: "", matches: [], cursor: 0 };
}

/**
 * Indices of entries containing `query` (substring, case-insensitive),
 * examined newest→oldest so matches[0] is the most recent hit. The empty
 * query matches nothing — Ctrl+R shows no candidate until you type.
 */
function computeMatches(query: string, entries: readonly string[]): number[] {
  if (query === "") return [];
  const q = query.toLowerCase();
  const matches: number[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if ((entries[i] ?? "").toLowerCase().includes(q)) matches.push(i);
  }
  return matches;
}

/** Appends a typed character and recomputes matches; the cursor resets to the newest hit. */
export function searchInput(s: HistorySearch, entries: readonly string[], char: string): HistorySearch {
  const query = s.query + char;
  return { query, matches: computeMatches(query, entries), cursor: 0 };
}

/** Drops the last query character and recomputes (widening); the cursor resets to the newest hit. */
export function searchBackspace(s: HistorySearch, entries: readonly string[]): HistorySearch {
  const query = s.query.slice(0, previousGraphemeBoundary(s.query, s.query.length));
  return { query, matches: computeMatches(query, entries), cursor: 0 };
}

/** Ctrl+R again: step to the next-older match, clamped at the oldest one. */
export function searchNext(s: HistorySearch): HistorySearch {
  if (s.matches.length === 0) return s;
  return { ...s, cursor: Math.min(s.cursor + 1, s.matches.length - 1) };
}

/** The entry text under the cursor (verbatim, including newlines), or null. */
export function currentMatch(s: HistorySearch, entries: readonly string[]): string | null {
  const index = s.matches[s.cursor];
  if (index === undefined) return null;
  return entries[index] ?? null;
}
