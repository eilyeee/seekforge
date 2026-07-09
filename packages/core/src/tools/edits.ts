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
 * Normalize a single line for whitespace-tolerant comparison: drop a trailing
 * CR (CRLF tolerance), strip leading indentation, trim trailing whitespace, and
 * collapse interior runs of whitespace to a single space. This makes the match
 * robust to the most common model mistake — getting indentation or incidental
 * spacing slightly wrong — without being so loose that distinct lines collide.
 */
function normalizeLine(line: string): string {
  return line.replace(/\r$/, "").replace(/\s+/g, " ").trim();
}

type FuzzyRegion = { startLine: number; endLineExclusive: number };

/**
 * Find every contiguous run of N lines in `lines` whose normalized form equals
 * the normalized `oldLines` (N lines). Returns the matching regions as line
 * index spans. Empty oldLines never matches.
 */
function findFuzzyRegions(lines: string[], oldLines: string[]): FuzzyRegion[] {
  const n = oldLines.length;
  if (n === 0) return [];
  const normTarget = oldLines.map(normalizeLine);
  const regions: FuzzyRegion[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (normalizeLine(lines[i + j] as string) !== (normTarget[j] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) regions.push({ startLine: i, endLineExclusive: i + n });
  }
  return regions;
}

/**
 * Apply search/replace edits. Each oldString must occur exactly once in the
 * content *at the time it is applied*. All-or-nothing: any failure throws and
 * the caller must not persist anything.
 *
 * Matching, per edit, in priority order:
 *  1. EXACT verbatim match. If oldString occurs exactly once, use it (preferred).
 *     If it occurs more than once, throw `ambiguous` (never fall back to fuzzy).
 *  2. If exact count is 0, attempt a WHITESPACE-TOLERANT line-based match:
 *     compare each line after stripping leading indentation, trimming trailing
 *     whitespace, and collapsing interior whitespace runs (CRLF-tolerant). If
 *     exactly one contiguous N-line region matches, replace the file's REAL
 *     spanned text with newString. Zero -> `no_match`; more than one -> `ambiguous`.
 */
export function applyEdits(content: string, edits: SearchReplaceEdit[]): string {
  let next = content;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as SearchReplaceEdit;
    // Empty oldString is always rejected (matches every position / is meaningless).
    if (edit.oldString.length === 0) {
      throw new ToolError(
        "no_match",
        `Edit ${i + 1}/${edits.length}: oldString is empty`,
        { editIndex: i, hint: "" },
      );
    }

    const count = countOccurrences(next, edit.oldString);

    // 1a. Exact, unique match — preferred.
    if (count === 1) {
      next = next.replace(edit.oldString, () => edit.newString);
      continue;
    }
    // 1b. Exact but ambiguous — never fall back to fuzzy.
    if (count > 1) {
      throw new ToolError(
        "ambiguous",
        `Edit ${i + 1}/${edits.length}: oldString matches ${count} times; add surrounding context to make it unique`,
        { editIndex: i, matchCount: count },
      );
    }

    // 2. count === 0: whitespace-tolerant fallback.
    // Drop a single trailing newline from oldString so a trailing-newline block
    // is compared as its constituent lines, not an extra empty line.
    const oldForLines = edit.oldString.replace(/\r?\n$/, "");
    const oldLines = oldForLines.split("\n");
    const lines = next.split("\n");
    const regions = findFuzzyRegions(lines, oldLines);

    if (regions.length === 0) {
      throw new ToolError(
        "no_match",
        `Edit ${i + 1}/${edits.length}: oldString not found in file`,
        { editIndex: i, hint: closestRegion(next, edit.oldString) },
      );
    }
    if (regions.length > 1) {
      throw new ToolError(
        "ambiguous",
        `Edit ${i + 1}/${edits.length}: oldString matches ${regions.length} regions (whitespace-tolerant); add surrounding context to make it unique`,
        { editIndex: i, matchCount: regions.length },
      );
    }

    // Exactly one region: replace the ACTUAL spanned text (preserving the file's
    // real surrounding content / whitespace) with newString.
    const region = regions[0] as FuzzyRegion;
    // `lines` came from split("\n"), so every element that ended in CRLF still
    // carries a trailing "\r". Rebuild the file preserving EACH original line's
    // OWN terminator: a single global EOL would, in a MIXED-EOL file, silently
    // rewrite the CRLF/LF of every untouched line outside the edited span. Only
    // the replaced block's terminator is chosen fresh (from the line it replaces).
    const lastIdx = lines.length - 1;
    // Terminator that originally followed line i: "" for the final token (no
    // trailing newline), else CRLF/LF per whether split("\n") left a "\r".
    const termAfter = (i: number): string =>
      i >= lastIdx ? "" : (lines[i] as string).endsWith("\r") ? "\r\n" : "\n";
    const content = (i: number): string => (lines[i] as string).replace(/\r$/, "");

    const out: string[] = [];
    for (let k = 0; k < region.startLine; k++) out.push(content(k) + termAfter(k));
    // The inserted block inherits the terminator of the line it replaces (the
    // region's last line): a CRLF line stays CRLF, a bare-LF line stays LF, and
    // its interior newlines are normalized to that same terminator so the block
    // itself is internally consistent.
    const blockEol = termAfter(region.endLineExclusive - 1);
    // Normalize the inserted block to the block's terminator in BOTH directions:
    // a CRLF block gets CRLF, and a bare-LF block gets LF — the latter strips any
    // stray "\r" the model emitted (echoed CRLF) so an LF file stays pure LF.
    const newBlock =
      blockEol === "\r\n" ? edit.newString.replace(/\r?\n/g, "\r\n") : edit.newString.replace(/\r\n/g, "\n");
    out.push(newBlock + blockEol);
    for (let k = region.endLineExclusive; k < lines.length; k++) out.push(content(k) + termAfter(k));
    next = out.join("");
  }
  return next;
}
