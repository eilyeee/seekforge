/**
 * Pure logic for the rich composer (components/chat/Composer.tsx): slash
 * palette filtering, @-token detection/insertion, image marker insertion,
 * and per-workspace input history. No React, no fetch — unit tested in
 * composer.test.ts. Re-derived from the TUI's fuzzy/commands/history modules
 * (apps must not import across each other).
 */

/** A web-relevant slash command; the registry is built by ChatView. */
export type ComposerCommand = {
  /** Name without the leading slash, e.g. "new". */
  name: string;
  /** One-line description shown in the palette. */
  hint: string;
  /** Executes the command (the composer clears its input afterwards). */
  run: () => void;
};

// ---------------------------------------------------------------------------
// Fuzzy matching (case-insensitive subsequence with positional bonuses).

/** Characters whose following position counts as a word boundary. */
const SEPARATORS = new Set(["/", ".", "_", "-", " "]);

/**
 * Scores `text` against `query`. Null when the query is not a subsequence;
 * higher is better. The empty query matches everything with score 0.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let prevMatch = -2; // -2 so the first char never looks "consecutive"
  for (let qi = 0; qi < q.length; qi += 1) {
    const idx = t.indexOf(q[qi] ?? "", ti);
    if (idx === -1) return null;
    score += 1;
    if (idx === prevMatch + 1 && prevMatch >= 0) score += 2; // consecutive run
    if (idx === 0) score += 3; // match at the very start
    else if (SEPARATORS.has(t[idx - 1] ?? "")) score += 2; // boundary match
    prevMatch = idx;
    ti = idx + 1;
  }
  return score;
}

/** Ranks the registry against the palette query (misses dropped, stable order). */
export function filterCommands(query: string, commands: readonly ComposerCommand[]): ComposerCommand[] {
  const scored: Array<{ cmd: ComposerCommand; score: number; order: number }> = [];
  for (let i = 0; i < commands.length; i += 1) {
    const cmd = commands[i] as ComposerCommand;
    const score = fuzzyScore(query, cmd.name);
    if (score !== null) scored.push({ cmd, score, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.map((s) => s.cmd);
}

// ---------------------------------------------------------------------------
// Active-token detection (drives which dropdown is open).

/**
 * The slash-palette query: non-null while the input starts with "/" and the
 * caret is still inside the first whitespace-free token ("/mod|" → "mod").
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith("/") || caret < 1) return null;
  const head = text.slice(1, caret);
  if (/\s/.test(head)) return null;
  return head;
}

export type AtToken = { start: number; query: string };

/**
 * The @ file-picker token under the caret: an "@" at the start of the text or
 * after whitespace, with no whitespace between it and the caret. Emails and
 * handles ("a@b") never trigger it. Returns the token's start index (at the
 * "@") and the query typed so far.
 */
export function atToken(text: string, caret: number): AtToken | null {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) return null;
    if (ch === "@") {
      const prev = text[i - 1];
      if (prev !== undefined && !/\s/.test(prev)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
  }
  return null;
}

/** Replaces the @-token [start, caret) with `@path ` and reposition the caret. */
export function insertAtPath(
  text: string,
  token: AtToken,
  caret: number,
  path: string,
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, token.start) + inserted + text.slice(caret),
    caret: token.start + inserted.length,
  };
}

// ---------------------------------------------------------------------------
// Image markers ("[image #N: path]" travels in the task; image_analyze
// consumes the workspace-relative path).

const IMAGE_MARKER_RE = /\[image #(\d+): [^\]]+\]/g;

/** Builds the marker text for the (count+1)-th image in `text`. */
export function imageMarker(text: string, path: string): string {
  let max = 0;
  for (const m of text.matchAll(IMAGE_MARKER_RE)) {
    max = Math.max(max, Number(m[1]));
  }
  return `[image #${max + 1}: ${path}]`;
}

/** Inserts the marker at the selection, padding with spaces where needed. */
export function insertImageMarker(
  text: string,
  selStart: number,
  selEnd: number,
  path: string,
): { text: string; caret: number } {
  const marker = imageMarker(text, path);
  const before = text.slice(0, selStart);
  const after = text.slice(selEnd);
  const lead = before === "" || /\s$/.test(before) ? "" : " ";
  const trail = after.startsWith(" ") || after === "" ? "" : " ";
  const inserted = lead + marker + trail;
  return { text: before + inserted + after, caret: selStart + inserted.length };
}

// ---------------------------------------------------------------------------
// History (per-workspace, localStorage-backed, readline ↑/↓ semantics).

/** The subset of Storage the history helpers need (injectable for tests). */
export type KVStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export const HISTORY_LIMIT = 100;

export function historyKey(workspaceId: string): string {
  return `seekforge.composer.history.${workspaceId || "default"}`;
}

/** Loads history oldest→newest; tolerates a missing key and corrupt JSON. */
export function loadHistory(storage: KVStorage, workspaceId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(historyKey(workspaceId)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string").slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Appends an entry (skipping consecutive duplicates), capped at 100. */
export function pushHistory(storage: KVStorage, workspaceId: string, entry: string): string[] {
  const entries = loadHistory(storage, workspaceId);
  if (entries[entries.length - 1] !== entry) entries.push(entry);
  const kept = entries.slice(-HISTORY_LIMIT);
  try {
    storage.setItem(historyKey(workspaceId), JSON.stringify(kept));
  } catch {
    // quota/private-mode failures lose persistence, not the session
  }
  return kept;
}

export type HistoryNav = {
  /** ↑: saves the draft on first call, walks back; null at the oldest. */
  up(draft: string): string | null;
  /** ↓: walks forward; returns the saved draft past the newest; null at the draft. */
  down(): string | null;
  reset(): void;
};

/**
 * Readline semantics: the first up() saves the in-progress draft and returns
 * the newest entry; further up() walks back (null at the oldest); down()
 * walks forward and restores the draft when stepping past the newest.
 */
export function createHistoryNav(entries: readonly string[]): HistoryNav {
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

/** True when ↑ should recall history: the caret sits on the first line. */
export function atTopEdge(text: string, selStart: number): boolean {
  return !text.slice(0, selStart).includes("\n");
}

/** True when ↓ should walk history forward: the caret sits on the last line. */
export function atBottomEdge(text: string, selEnd: number): boolean {
  return !text.slice(selEnd).includes("\n");
}
