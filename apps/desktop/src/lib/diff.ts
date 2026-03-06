/** Unified-diff line classification for colored rendering. Pure logic. */

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export type DiffLine = { kind: DiffLineKind; text: string };

export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff ") ||
    line.startsWith("index ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export function splitDiff(diff: string): DiffLine[] {
  const lines = diff.split("\n");
  // Drop a single trailing empty line produced by a final "\n".
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((text) => ({ kind: classifyDiffLine(text), text }));
}

/** True when a tool result payload carries a renderable unified diff. */
export function extractDiff(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const diff = (data as Record<string, unknown>).diff;
  return typeof diff === "string" && diff.length > 0 ? diff : null;
}
