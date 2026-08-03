/**
 * Unified-diff rendering for edit review.
 *
 * Every write tool shows the user what it is about to change as a diff. That
 * diff has to be computed with no dependencies and no I/O beyond reading the
 * current file, because it is built on the permission path — before the write,
 * while the user is still deciding. This module owns that one job so the tools
 * that need it (apply_patch, write_file, lsp_rename) share an identical
 * renderer instead of importing each other.
 */

// Cap the rendered diff so a huge rewrite cannot bloat the permission prompt.
// Beyond this the diff is truncated with a marker line.
const MAX_PREVIEW_DIFF_LINES = 400;

/** Split into lines, dropping the empty tail produced by a trailing newline. */
function splitDiffLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Minimal pure unified diff (LCS over lines) of `before` → `after`. `null`
 * before = file creation. Output is capped at MAX_PREVIEW_DIFF_LINES with a
 * truncation marker.
 *
 * Performance: the LCS DP table is only filled for the MIDDLE of the files —
 * the common leading and trailing lines are trimmed first (the standard diff
 * optimization), so the typical "tiny edit in a big file" costs O(edit²)
 * instead of O(n·m) (~16M cells at the 4000-line guard). The output stays
 * byte-identical to the untrimmed algorithm: the emit walk still runs over the
 * FULL line arrays with the original tie-breaking, backed by an O(1) accessor
 * that reconstructs exact full-table DP values (see `dp` below) — naive
 * "diff only the middle" is NOT equivalent, because the walk may legitimately
 * match a middle line against a trimmed-suffix line (e.g. a=[x,s] b=[s,s]).
 *
 * The regression tests compare it line-for-line against an inline untrimmed
 * reference.
 */
export function unifiedDiff(before: string | null, after: string, relPath: string): string {
  const a = splitDiffLines(before ?? "");
  const b = splitDiffLines(after);
  const header = `--- a/${relPath}\n+++ b/${relPath}`;

  const n = a.length;
  const m = b.length;
  // Guard pathological sizes by falling back to del-all/add-all. Kept on the
  // FULL lengths (not the trimmed middle) so output is identical to before.
  const body: string[] = [];
  if (n > 4000 || m > 4000) {
    body.push(`@@ -${n > 0 ? 1 : 0},${n} +${m > 0 ? 1 : 0},${m} @@`);
    for (const line of a) body.push(`-${line}`);
    for (const line of b) body.push(`+${line}`);
  } else {
    // Trim the common prefix and suffix (suffix bounded so they never overlap).
    let pre = 0;
    const maxPre = Math.min(n, m);
    while (pre < maxPre && a[pre] === b[pre]) pre++;
    let suf = 0;
    const maxSuf = maxPre - pre;
    while (suf < maxSuf && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    const midN = n - pre - suf;
    const midM = m - pre - suf;

    // LCS DP over the middle only, in a flat typed array (row-major, width
    // midM+1) — cheaper to allocate and index than an array-of-arrays.
    const width = midM + 1;
    const table = new Uint32Array((midN + 1) * width);
    for (let i = midN - 1; i >= 0; i--) {
      for (let j = midM - 1; j >= 0; j--) {
        table[i * width + j] =
          a[pre + i] === b[pre + j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }

    // Full-table DP value at (i, j), reconstructed in O(1):
    //  - prefix rows/cols are never consulted (the walk consumes the common
    //    prefix as matches before its first dp lookup, so i, j >= pre there);
    //  - middle × middle: LCS(x + S, y + S) = LCS(x, y) + |S| for a common
    //    suffix S, so the middle table value shifts uniformly by `suf`;
    //  - once i or j is inside the trimmed suffix, one remainder is a suffix
    //    of the other's tail (both end in S), so the LCS is just the shorter
    //    remaining length: min(n - i, m - j).
    const aSufStart = n - suf;
    const bSufStart = m - suf;
    const dp = (i: number, j: number): number =>
      i >= aSufStart || j >= bSufStart ? Math.min(n - i, m - j) : table[(i - pre) * width + (j - pre)]! + suf;

    // Emit walk over the FULL arrays — logic and tie-breaks unchanged.
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        body.push(` ${a[i]}`);
        i++;
        j++;
      } else if (dp(i + 1, j) >= dp(i, j + 1)) {
        body.push(`-${a[i]}`);
        i++;
      } else {
        body.push(`+${b[j]}`);
        j++;
      }
    }
    while (i < n) body.push(`-${a[i++]}`);
    while (j < m) body.push(`+${b[j++]}`);
    body.unshift(`@@ -${n > 0 ? 1 : 0},${n} +${m > 0 ? 1 : 0},${m} @@`);
  }

  let lines = body;
  if (lines.length > MAX_PREVIEW_DIFF_LINES) {
    const hidden = lines.length - MAX_PREVIEW_DIFF_LINES;
    lines = [...lines.slice(0, MAX_PREVIEW_DIFF_LINES), `@@ … ${hidden} more lines truncated @@`];
  }
  return `${header}\n${lines.join("\n")}`;
}

/**
 * Number of changed (added + removed) lines in a rendered unified diff. Used to
 * summarize a multi-file edit in one line without re-diffing.
 */
export function countChangedLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}
