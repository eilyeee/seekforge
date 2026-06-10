import { ToolError } from "./errors.js";

export type SearchReplaceEdit = { oldString: string; newString: string };

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Bounded Levenshtein distance (lines are truncated to keep this cheap). */
function editDistance(a: string, b: string): number {
  const s = a.slice(0, 200);
  const t = b.slice(0, 200);
  const m = s.length;
  const n = t.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min((cur[j - 1] as number) + 1, (prev[j] as number) + 1, (prev[j - 1] as number) + cost);
    }
    prev = cur;
  }
  return prev[n] as number;
}

/** Find the region of `content` that looks most like `oldString` (for no_match hints). */
export function closestRegion(content: string, oldString: string): string {
  const target = oldString
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!target) return "";
  const lines = content.split("\n");
  let bestIdx = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.length === 0) continue;
    const score = editDistance(target, line) / Math.max(target.length, line.length, 1);
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(lines.length, bestIdx + 3);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}: ${l}`)
    .join("\n");
}

/**
 * Apply search/replace edits. Each oldString must occur exactly once in the
 * content *at the time it is applied*. All-or-nothing: any failure throws and
 * the caller must not persist anything.
 */
export function applyEdits(content: string, edits: SearchReplaceEdit[]): string {
  let next = content;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as SearchReplaceEdit;
    const count = countOccurrences(next, edit.oldString);
    if (count === 0) {
      throw new ToolError(
        "no_match",
        `Edit ${i + 1}/${edits.length}: oldString not found in file`,
        { editIndex: i, hint: closestRegion(next, edit.oldString) },
      );
    }
    if (count > 1) {
      throw new ToolError(
        "ambiguous",
        `Edit ${i + 1}/${edits.length}: oldString matches ${count} times; add surrounding context to make it unique`,
        { editIndex: i, matchCount: count },
      );
    }
    next = next.replace(edit.oldString, () => edit.newString);
  }
  return next;
}
