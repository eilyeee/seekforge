/**
 * Pure line-based diff used by the inline DiffCard. Classic LCS dynamic
 * programming over lines, emitting unified-style hunks (`@@ -a,b +c,d @@`)
 * with prefixed add/del/ctx lines. A size guard skips the DP for very large
 * files and falls back to a truncated del-all/add-all hunk. No I/O here.
 */
import type { DiffLine } from "./model.js";

/** Either side larger than this skips the DP entirely. */
const MAX_DP_LINES = 2000;
/** Lines kept per side on the truncated fallback path. */
const TRUNCATE_LINES = 200;
const DEFAULT_CONTEXT = 2;

/**
 * Computes colored diff lines between two file contents. `null` means the
 * file does not exist on that side (creation / deletion). Identical inputs
 * produce an empty array.
 */
export function computeDiffLines(
  before: string | null,
  after: string | null,
  context: number = DEFAULT_CONTEXT,
): DiffLine[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length > MAX_DP_LINES || b.length > MAX_DP_LINES) return truncatedDiff(a, b);
  const ops = diffOps(a, b);
  if (!ops.some((op) => op.kind !== "eq")) return [];
  return buildHunks(ops, Math.max(0, context));
}

/** Splits content into lines, ignoring a trailing newline's empty tail. */
function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type OpKind = "eq" | "del" | "add";
/** aPos/bPos = number of before/after lines consumed BEFORE this op. */
type Op = { kind: OpKind; text: string; aPos: number; bPos: number };

/** Full edit script via LCS backtracking (deletions before additions). */
function diffOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // dp[i * width + j] = LCS length of a[i:] vs b[j:]; LCS <= 2000 fits Uint16.
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1]! + 1
          : Math.max(dp[(i + 1) * width + j]!, dp[i * width + j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", text: a[i]!, aPos: i, bPos: j });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + j + 1]!) {
      ops.push({ kind: "del", text: a[i]!, aPos: i, bPos: j });
      i += 1;
    } else {
      ops.push({ kind: "add", text: b[j]!, aPos: i, bPos: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: a[i]!, aPos: i, bPos: j });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", text: b[j]!, aPos: i, bPos: j });
    j += 1;
  }
  return ops;
}

/**
 * Groups change runs into hunks padded with `context` equal lines on each
 * side; hunks whose padded ranges overlap or touch are joined into one.
 */
function buildHunks(ops: Op[], context: number): DiffLine[] {
  const ranges: Array<{ start: number; end: number }> = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.kind === "eq") {
      k += 1;
      continue;
    }
    let end = k;
    while (end + 1 < ops.length && ops[end + 1]!.kind !== "eq") end += 1;
    const padded = { start: Math.max(0, k - context), end: Math.min(ops.length - 1, end + context) };
    const prev = ranges[ranges.length - 1];
    if (prev && padded.start <= prev.end + 1) {
      prev.end = padded.end;
    } else {
      ranges.push(padded);
    }
    k = end + 1;
  }

  const out: DiffLine[] = [];
  for (const range of ranges) {
    let oldCount = 0;
    let newCount = 0;
    for (let idx = range.start; idx <= range.end; idx += 1) {
      const op = ops[idx]!;
      if (op.kind !== "add") oldCount += 1;
      if (op.kind !== "del") newCount += 1;
    }
    const first = ops[range.start]!;
    const oldStart = oldCount > 0 ? first.aPos + 1 : first.aPos;
    const newStart = newCount > 0 ? first.bPos + 1 : first.bPos;
    out.push({ kind: "hunk", text: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@` });
    for (let idx = range.start; idx <= range.end; idx += 1) {
      const op = ops[idx]!;
      if (op.kind === "eq") out.push({ kind: "ctx", text: ` ${op.text}` });
      else if (op.kind === "del") out.push({ kind: "del", text: `-${op.text}` });
      else out.push({ kind: "add", text: `+${op.text}` });
    }
  }
  return out;
}

/** Oversized fallback: del-all/add-all, 200 lines per side, marked truncated. */
function truncatedDiff(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [
    { kind: "hunk", text: `@@ -${a.length > 0 ? 1 : 0},${a.length} +${b.length > 0 ? 1 : 0},${b.length} @@` },
  ];
  for (const line of a.slice(0, TRUNCATE_LINES)) out.push({ kind: "del", text: `-${line}` });
  for (const line of b.slice(0, TRUNCATE_LINES)) out.push({ kind: "add", text: `+${line}` });
  out.push({ kind: "hunk", text: "@@ … truncated @@" });
  return out;
}
