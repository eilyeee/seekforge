/**
 * Head+tail truncation for large tool outputs. Snaps the cut points to line
 * boundaries so a truncated code/text blob never ends or resumes mid-line —
 * the model always sees whole lines (far easier to parse than a severed
 * `function foo(a, b`). Falls back to a raw char cut when the content has no
 * newline in range (e.g. one giant minified line).
 */
export function truncateHeadTail(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  // Reserve a roughly constant marker budget (the digit count varies slightly).
  const reserve = "\n... [truncated 0000000 chars] ...\n".length;
  const keep = Math.max(maxChars - reserve, 0);
  // Budget too small to fit the marker + content: hard-cap to stay within it.
  if (keep === 0) return { text: text.slice(0, maxChars), truncated: true };
  const head = Math.ceil(keep / 2);
  const tail = keep - head;

  // Snap the head end back to the last newline within budget (keep through it).
  const lastNl = text.lastIndexOf("\n", head);
  const headCut = lastNl >= 0 ? lastNl + 1 : head;
  // Snap the tail start forward to the next newline (resume on a line boundary).
  const tailStart = text.length - tail;
  const nextNl = tail > 0 ? text.indexOf("\n", tailStart) : -1;
  const tailCutStart = nextNl >= 0 ? nextNl + 1 : tailStart;

  const omitted = Math.max(0, tailCutStart - headCut);
  const marker = `\n... [truncated ${omitted} chars] ...\n`;
  return {
    text: text.slice(0, headCut) + marker + text.slice(tailCutStart),
    truncated: true,
  };
}
