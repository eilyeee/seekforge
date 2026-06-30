/**
 * Head+tail truncation for large tool outputs. Cut points snap to line
 * boundaries so a truncated blob never ends/resumes mid-line. When `ranges`
 * (char spans of top-level code constructs, from tree-sitter) are supplied AND
 * a clean split exists, it cuts on CONSTRUCT boundaries instead — so a truncated
 * code file shows whole functions/classes, not a severed one. Falls back to the
 * line-aware (then raw char) cut otherwise.
 */
export function truncateHeadTail(
  text: string,
  maxChars: number,
  opts?: { ranges?: { start: number; end: number }[] },
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Reserve a roughly constant marker budget (the digit count varies slightly).
  const reserve = "\n... [truncated 0000000 chars] ...\n".length;
  const keep = Math.max(maxChars - reserve, 0);
  // Budget too small to fit the marker + content: hard-cap to stay within it.
  if (keep === 0) return { text: text.slice(0, maxChars), truncated: true };
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  const tailStart = text.length - tail;

  // Line-aware baseline (always valid: headCut < tailStart <= tailCutStart).
  const lastNl = text.lastIndexOf("\n", head);
  let headCut = lastNl >= 0 ? lastNl + 1 : head;
  const nextNl = tail > 0 ? text.indexOf("\n", tailStart) : -1;
  let tailCutStart = nextNl >= 0 ? nextNl + 1 : tailStart;

  // Prefer construct boundaries: head ends after the last construct fully within
  // budget; tail resumes at the first construct at/after tailStart. Only applied
  // when both exist and don't overlap (else keep the safe line-aware baseline).
  const ranges = opts?.ranges;
  if (ranges && ranges.length > 0) {
    let h = -1;
    for (const r of ranges) {
      if (r.end <= head) h = r.end;
      else break; // ranges are in top-level order
    }
    let tcs = -1;
    for (const r of ranges) {
      if (r.start >= tailStart) {
        tcs = r.start;
        break;
      }
    }
    if (h > 0 && tcs > h) {
      headCut = h;
      tailCutStart = tcs;
    }
  }

  const omitted = Math.max(0, tailCutStart - headCut);
  const marker = `\n... [truncated ${omitted} chars] ...\n`;
  return {
    text: text.slice(0, headCut) + marker + text.slice(tailCutStart),
    truncated: true,
  };
}
