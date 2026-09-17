/** Splits a unified git diff into per-file sections with change stats. */

export type FileDiff = {
  /** New path (or old path for deletions). */
  path: string;
  additions: number;
  deletions: number;
  /** The file's full diff text including its `diff --git` header. */
  text: string;
};

// Paths with spaces/non-ASCII (e.g. Chinese filenames) are quoted by git:
//   diff --git "a/\346\226\207 件.ts" "b/\346\226\207 件.ts"
const HEADER_RE = /^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+)"|b\/(.+))$/;

/** Unescapes git's C-style quoting (\303\244 octal bytes, \t, \", \\). */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    const c = quoted[i] as string;
    if (c !== "\\") {
      bytes.push(...new TextEncoder().encode(c));
      continue;
    }
    const next = quoted[i + 1];
    if (next !== undefined && /[0-7]/.test(next)) {
      bytes.push(Number.parseInt(quoted.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      const map: Record<string, string> = { t: "\t", n: "\n", '"': '"', "\\": "\\" };
      bytes.push(...new TextEncoder().encode(map[next ?? ""] ?? next ?? ""));
      i += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export function splitDiffByFile(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | undefined;

  for (const line of diff.split("\n")) {
    const header = HEADER_RE.exec(line);
    if (header) {
      if (current) files.push(current);
      const quotedB = header[3];
      const path = quotedB !== undefined ? unquoteGitPath(quotedB) : ((header[4] ?? header[2]) as string);
      current = { path, additions: 0, deletions: 0, text: line };
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

/**
 * One file's diff split into its header and hunks, for per-hunk actions. Each
 * hunk is the exact text git printed (from its `@@` line), which is what the
 * server matches against its own fresh diff before applying anything.
 * `actionable` is false for diffs a hunk patch cannot express (binary files,
 * renames, mode-only changes), where only whole-file actions make sense.
 */
export function splitFileHunks(fileText: string): { header: string; hunks: string[]; actionable: boolean } {
  const lines = fileText.split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const line of lines) {
    if (line.startsWith("@@ ")) hunks.push([line]);
    else if (hunks.length > 0) hunks[hunks.length - 1]!.push(line);
    else header.push(line);
  }
  const renamed = header.some((line) => line.startsWith("rename from ") || line.startsWith("copy from "));
  return {
    header: header.join("\n"),
    hunks: hunks.map((hunk) => hunk.join("\n")),
    actionable: hunks.length > 0 && !renamed,
  };
}

/** Keeps the files a session touched (exact workspace-relative paths). */
export function filterToPaths<T extends { path: string }>(files: T[], paths: ReadonlySet<string> | null): T[] {
  return paths === null ? files : files.filter((file) => paths.has(file.path));
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
