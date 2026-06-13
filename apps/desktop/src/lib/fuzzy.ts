/**
 * Tiny fuzzy subsequence matcher for the "go to file" finder. Returns the
 * matched character positions (for highlighting) and a score, or null when the
 * query is not a subsequence of the target. Scoring favors consecutive runs and
 * matches at segment boundaries (start, after / . _ -), and shorter targets.
 */
export type FuzzyMatch = { score: number; positions: number[] };

const BOUNDARY = new Set(["/", ".", "_", "-", " "]);

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const first = positions.length === 0;
    if (ti === prev + 1 && !first) {
      score += 10; // consecutive run — the strongest signal
    } else {
      score += 1;
      if (!first) score -= Math.min(ti - prev - 1, 10); // penalize the gap (capped)
    }
    if (ti === 0 || BOUNDARY.has(target[ti - 1] as string)) score += 5; // segment-boundary bonus
    positions.push(ti);
    prev = ti;
    qi++;
  }
  if (qi < q.length) return null; // not all query chars consumed
  score -= target.length * 0.02; // prefer shorter paths on ties
  return { score, positions };
}

/** Filters + ranks targets by fuzzy score (best first). Non-matches dropped. */
export function fuzzyRank<T>(query: string, items: T[], key: (item: T) => string): { item: T; match: FuzzyMatch }[] {
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, key(item));
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out;
}
