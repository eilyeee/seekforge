/** Splits a unified git diff into per-file sections with change stats. */

export type FileDiff = {
  /** New path (or old path for deletions). */
  path: string;
  additions: number;
  deletions: number;
  /** The file's full diff text including its `diff --git` header. */
  text: string;
};

const HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

export function splitDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;

  for (const line of diff.split("\n")) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (current) files.push(current);
      current = { path: header[2] as string, additions: 0, deletions: 0, text: line };
      continue;
    }
    if (!current) continue; // preamble before the first header
    current.text += `\n${line}`;
    if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
  }
  if (current) files.push(current);
  return files;
}

export function diffTotals(files: FileDiff[]): { files: number; additions: number; deletions: number } {
  return files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      additions: acc.additions + f.additions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
}
