/**
 * The before/after file contents behind a permission preview, for the IDE's
 * diff view.
 *
 * Core renders a write preview as ONE hunk spanning the whole file (every line
 * is context, an addition or a deletion), so both sides can be read straight
 * back out of it. A preview core truncated, or one covering several files,
 * cannot be reconstructed and is refused rather than shown partially.
 */

export type ReconstructedFile = { original: string; proposed: string };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/;

export function reconstructFromPreview(diff: string, currentContent?: string | null): ReconstructedFile | null {
  const lines = diff.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let index = 0;
  while (index < lines.length && (lines[index]?.startsWith("--- ") || lines[index]?.startsWith("+++ "))) index += 1;
  if (index !== 2) return null;
  const header = HUNK_HEADER.exec(lines[index] ?? "");
  if (!header) return null;
  const oldCount = Number(header[2] ?? "1");
  const newCount = Number(header[4] ?? "1");
  // Only a hunk that starts at the top of both files covers them entirely.
  if (Number(header[1]) > 1 || Number(header[3]) > 1) return null;
  const before: string[] = [];
  const after: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const marker = line[0];
    const text = line.slice(1);
    if (marker === " ") {
      before.push(text);
      after.push(text);
    } else if (marker === "-") {
      before.push(text);
    } else if (marker === "+") {
      after.push(text);
    } else {
      // A second hunk, a truncation marker, or another file's header.
      return null;
    }
  }
  if (before.length !== oldCount || after.length !== newCount) return null;
  const joinedBefore = before.join("\n");
  // The preview drops the final newline; keep the file's own convention.
  let newline = before.length > 0 || after.length > 0 ? "\n" : "";
  if (typeof currentContent === "string") {
    const current = currentContent.endsWith("\n") ? currentContent.slice(0, -1) : currentContent;
    if (current !== joinedBefore) return null;
    if (before.length > 0) newline = currentContent.endsWith("\n") ? "\n" : "";
  }
  return {
    original:
      typeof currentContent === "string" ? currentContent : before.length > 0 ? `${joinedBefore}${newline}` : "",
    proposed: after.length > 0 ? `${after.join("\n")}${newline}` : "",
  };
}
