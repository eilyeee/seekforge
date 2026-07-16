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

/** Lines that signal a failure in test/build output (used to bias the digest). */
const FAILURE_LINE =
  /\b(?:fail(?:ed|ing|ure|ures)?|errors?|exception|assert|expected|not ok|panic|traceback)\b|[✕✗✘✖×]/iu;

/**
 * Condense captured command output (e.g. a verify run) for feeding back to the
 * model. Returns it unchanged when it fits. When it overflows, keeps a line-
 * aware head+tail AND surfaces failure-signal lines from the OMITTED middle —
 * so a buried failing assertion survives instead of being lost between an even
 * head/tail split. Stays within ~maxChars (the surfaced lines borrow a third of
 * the budget; falls back to a plain head+tail when nothing looks like a failure).
 */
export function digestCommandOutput(output: string, maxChars: number): string {
  const trimmed = output.trim() || "(no output)";
  if (trimmed.length <= maxChars) return trimmed;
  const failBudget = Math.floor(maxChars / 3);
  const headTail = truncateHeadTail(trimmed, maxChars - failBudget).text;
  const failing: string[] = [];
  const seen = new Set<string>();
  for (const raw of trimmed.split("\n")) {
    if (failing.length >= 40) break;
    const line = raw.trim();
    if (!line || seen.has(line)) continue;
    if (FAILURE_LINE.test(line) && !headTail.includes(line)) {
      failing.push(line);
      seen.add(line);
    }
  }
  if (failing.length === 0) return truncateHeadTail(trimmed, maxChars).text;
  const extra = truncateHeadTail(failing.join("\n"), failBudget).text;
  return `${headTail}\n... [failure lines from the omitted region] ...\n${extra}`;
}
