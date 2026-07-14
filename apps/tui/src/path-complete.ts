/**
 * Tab completion of plain path tokens (no "@" — the file picker owns those).
 * Pure functions over EditorState plus the scanWorkspaceFiles index
 * (workspace-relative "/" paths).
 *
 * Expected app-side flow (all state lives in a ref, nothing here is stateful):
 *
 *   1. On the first Tab press, call startCompletion(editor, files); when it
 *      returns non-null, call applyCompletion(editor, completion) and store
 *      { completion, applied } in a ref, where `applied` is the resulting
 *      EditorState.
 *   2. On a further Tab press while the current editor state still equals
 *      `applied` (text and cursor untouched since the last apply), call
 *      cycleCompletion(completion) and applyCompletion again — the anchor
 *      inside the completion is the ORIGINAL token start, and because the
 *      applied candidate contains no whitespace, applyCompletion re-replaces
 *      exactly the previously inserted path. Store the new pair in the ref.
 *   3. Any other keystroke clears the ref, so the next Tab starts fresh.
 *
 * applyCompletion inserts NO trailing space, which is what keeps step 2's
 * "editor still matches the last applied state" check workable.
 */

import { COMMANDS } from "./commands.js";
import type { EditorState } from "./editor.js";
import { fuzzyRank } from "./fuzzy.js";

const MAX_CANDIDATES = 20;

/** Slash-command names that disqualify a "/name" token ("exit" is the /quit alias). */
const COMMAND_NAMES = new Set<string>([...COMMANDS.map((c) => c.name), "exit"]);

export type PathCompletion = {
  /** Start index of the token being completed. */
  anchor: number;
  /** Candidates in ranked order. */
  candidates: string[];
  /** Which candidate is currently applied (cycles on repeated Tab). */
  index: number;
};

export type TabPathCompletion = {
  tabId: number;
  completion: PathCompletion;
};

export function completionForTab(state: TabPathCompletion | null, tabId: number): PathCompletion | null {
  return state?.tabId === tabId ? state.completion : null;
}

/** True when `file` starts with `token` at index 0 or right after any "/" (case-insensitive). */
function prefixMatchAt(token: string, file: string): "path" | "segment" | null {
  const t = token.toLowerCase();
  const f = file.toLowerCase();
  if (f.startsWith(t)) return "path";
  let idx = f.indexOf("/");
  while (idx !== -1) {
    if (f.startsWith(t, idx + 1)) return "segment";
    idx = f.indexOf("/", idx + 1);
  }
  return null;
}

/**
 * Extracts the whitespace-delimited token containing/before the cursor when
 * it looks like a path (contains "/" or "." or is a prefix of a known file),
 * and builds the candidate list. Returns null for:
 * - empty tokens (cursor at start or after whitespace),
 * - "@" tokens (the file picker owns those),
 * - "/" + a known slash-command name (e.g. "/help"),
 * - "#"/"!" prefixed tokens at the start of a line (memory/bash shorthands),
 * - tokens with no path hints, or with no candidates at all.
 *
 * Candidates: files prefix-matching the token (full-path prefixes first,
 * then segment-boundary prefixes, both in scan order); when none, fuzzy
 * fallback via fuzzy.ts. Capped at 20.
 */
export function startCompletion(editor: EditorState, files: readonly string[]): PathCompletion | null {
  let anchor = editor.cursor;
  while (anchor > 0 && !/\s/.test(editor.text[anchor - 1] ?? "")) anchor -= 1;
  const token = editor.text.slice(anchor, editor.cursor);
  if (token === "") return null;
  if (token.startsWith("@")) return null;
  if (token.startsWith("/") && COMMAND_NAMES.has(token.slice(1).toLowerCase())) return null;
  const atLineStart = anchor === 0 || editor.text[anchor - 1] === "\n";
  if (atLineStart && (token.startsWith("#") || token.startsWith("!"))) return null;

  const pathMatches: string[] = [];
  const segmentMatches: string[] = [];
  for (const file of files) {
    const kind = prefixMatchAt(token, file);
    if (kind === "path") pathMatches.push(file);
    else if (kind === "segment") segmentMatches.push(file);
  }
  const looksLikePath = token.includes("/") || token.includes(".") || pathMatches.length > 0;
  if (!looksLikePath) return null;

  let candidates = [...pathMatches, ...segmentMatches].slice(0, MAX_CANDIDATES);
  if (candidates.length === 0) {
    candidates = fuzzyRank(token, files, (f) => f, MAX_CANDIDATES);
  }
  if (candidates.length === 0) return null;
  return { anchor, candidates, index: 0 };
}

/**
 * Replaces the whole token at `anchor` (anchor → next whitespace) with the
 * current candidate — no trailing space, so repeated Tab keeps cycling — and
 * lands the cursor at the end of the inserted path.
 */
export function applyCompletion(editor: EditorState, completion: PathCompletion): EditorState {
  const candidate = completion.candidates[completion.index] ?? "";
  let end = completion.anchor;
  while (end < editor.text.length && !/\s/.test(editor.text[end] ?? "")) end += 1;
  return {
    text: editor.text.slice(0, completion.anchor) + candidate + editor.text.slice(end),
    cursor: completion.anchor + candidate.length,
  };
}

/** Advances to the next candidate, wrapping past the last one. */
export function cycleCompletion(completion: PathCompletion): PathCompletion {
  return { ...completion, index: (completion.index + 1) % completion.candidates.length };
}
