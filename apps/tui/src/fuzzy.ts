/**
 * Pure fuzzy matcher shared by the command palette and the file picker.
 * Case-insensitive subsequence with simple positional bonuses (consecutive
 * runs, start-of-text, after a separator) — enough to make "mod" rank
 * "model" above "remodel" without pulling in a dependency.
 */

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
    if (idx === 0)
      score += 3; // match at the very start
    else if (SEPARATORS.has(t[idx - 1] ?? "")) score += 2; // boundary match
    prevMatch = idx;
    ti = idx + 1;
  }
  return score;
}

/** Ranks `items` by fuzzy score (descending), dropping misses; stable for equal scores. */
export function fuzzyRank<T>(query: string, items: readonly T[], key: (t: T) => string, limit?: number): T[] {
  const scored: Array<{ item: T; score: number; order: number }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as T;
    const score = fuzzyScore(query, key(item));
    if (score !== null) scored.push({ item, score, order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const ranked = scored.map((s) => s.item);
  return limit === undefined ? ranked : ranked.slice(0, limit);
}
