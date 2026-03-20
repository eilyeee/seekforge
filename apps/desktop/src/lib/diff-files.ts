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
      bytes.push(...new TextEncoder().encode(map[next ?? ""] ?? (next ?? "")));
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
