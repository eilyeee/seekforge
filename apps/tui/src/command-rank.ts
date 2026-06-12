/**
 * Usage-aware ranking for the command palette. Pure: usage is a plain
 * session-scoped record the app threads through; bumpUsage returns a new
 * object so React state updates stay referentially honest.
 */

import { fuzzyScore } from "./fuzzy.js";

/** Command name → use count (session-scoped). */
export type CommandUsage = Record<string, number>;

/** Returns a NEW usage record with `name` bumped by one. */
export function bumpUsage(usage: CommandUsage, name: string): CommandUsage {
  return { ...usage, [name]: (usage[name] ?? 0) + 1 };
}

/**
 * Ranks `specs` for the palette. Empty query: usage count descending, then
 * registry order. Non-empty: fuzzyScore over the NAME (primary; a null name
 * score disqualifies unless the summary matches — summary matches count
 * half), plus a log2(1+usage) boost. Stable; default limit 24.
 */
export function rankCommands<T extends { name: string; summary: string }>(
  query: string,
  specs: readonly T[],
  usage: CommandUsage,
  limit = 24,
): T[] {
  const scored: Array<{ spec: T; score: number; order: number }> = [];
  for (let i = 0; i < specs.length; i += 1) {
    const spec = specs[i] as T;
    const count = usage[spec.name] ?? 0;
    if (query === "") {
      scored.push({ spec, score: count, order: i });
      continue;
    }
    const nameScore = fuzzyScore(query, spec.name);
    let base: number;
    if (nameScore !== null) {
      base = nameScore;
    } else {
      const summaryScore = fuzzyScore(query, spec.summary);
      if (summaryScore === null) continue;
      base = summaryScore / 2;
    }
    scored.push({ spec, score: base + Math.log2(1 + count), order: i });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((s) => s.spec);
}

/** Greedy count of `input` characters matched as a subsequence of `name`. */
function subsequenceHits(input: string, name: string): number {
  const t = name.toLowerCase();
  let hits = 0;
  let ti = 0;
  for (const ch of input.toLowerCase()) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) continue; // skip the typo character, keep matching
    hits += 1;
    ti = idx + 1;
  }
  return hits;
}

/**
 * Best fuzzy match for a mistyped command name ("hlep" → "help"). Requires a
 * plausible match — at least half the input characters present as a
 * subsequence of the candidate name; null when nothing qualifies.
 */
export function didYouMean(input: string, specs: ReadonlyArray<{ name: string }>): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const needed = Math.max(1, Math.ceil(trimmed.length / 2));
  let best: { name: string; hits: number; lengthGap: number } | null = null;
  for (const spec of specs) {
    const hits = subsequenceHits(trimmed, spec.name);
    if (hits < needed) continue;
    const lengthGap = Math.abs(spec.name.length - trimmed.length);
    if (best === null || hits > best.hits || (hits === best.hits && lengthGap < best.lengthGap)) {
      best = { name: spec.name, hits, lengthGap };
    }
  }
  return best ? best.name : null;
}
