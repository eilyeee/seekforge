/** Head+tail truncation for large tool outputs. */
export function truncateHeadTail(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  const marker = `\n... [truncated ${omitted} chars] ...\n`;
  const keep = Math.max(maxChars - marker.length, 0);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return {
    text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ""),
    truncated: true,
  };
}
