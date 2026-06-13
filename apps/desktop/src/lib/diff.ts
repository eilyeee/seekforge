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

/**
 * Best-effort file path from a unified diff's header lines (for language
 * inference). Prefers the "+++ b/<path>" line, then "--- a/<path>", then the
 * "diff --git a/<path> b/<path>" line. Returns "" when no path is found.
 */
export function diffFilePath(diff: string): string {
  const strip = (p: string): string => p.replace(/^[ab]\//, "").trim();
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") && !line.includes("/dev/null")) {
      return strip(line.slice(4).split("\t")[0] ?? "");
    }
  }
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ") && !line.includes("/dev/null")) {
      return strip(line.slice(4).split("\t")[0] ?? "");
    }
    if (line.startsWith("diff --git ")) {
      const parts = line.slice("diff --git ".length).split(/\s+/);
      if (parts[1]) return strip(parts[1]);
      if (parts[0]) return strip(parts[0]);
    }
  }
  return "";
}

/** True when a tool result payload carries a renderable unified diff. */
export function extractDiff(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const diff = (data as Record<string, unknown>).diff;
  return typeof diff === "string" && diff.length > 0 ? diff : null;
}
