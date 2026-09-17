/**
 * `@path` import lines in Markdown instruction files — memory files and rule
 * files (AGENTS.md / CLAUDE.md). A line that is exactly `@<path>` is replaced
 * by the referenced file's text, recursively.
 *
 * The expansion owns the mechanics — depth limit, a shared size budget, cycle
 * protection, code fences — and nothing else. WHERE an import may point and
 * HOW it is read are the caller's `resolve` and `read`, because that is where
 * the trust decision lives: a repository file may not import from the user's
 * home directory, and the reader decides which filesystem root confines it.
 */

/** A whole line that is just `@<path>` (optional surrounding spaces). */
const IMPORT_LINE = /^\s*@(\S+)\s*$/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

export type LineImportOptions = {
  /** Map `spec` (the text after "@") found in the file `fromRel` to a file key, or undefined to refuse it. */
  resolve: (spec: string, fromRel: string) => string | undefined;
  /** Read a resolved file; undefined when it does not exist. Errors propagate. */
  read: (rel: string) => string | undefined;
  /** Imports nested deeper than this are not followed. */
  maxDepth: number;
  /** Characters the expansion may still add, shared by every file of one expansion. */
  budget: { remaining: number };
  /** Files already included — seed it with the root file, share it to dedupe across roots. */
  visited: Set<string>;
  /** Leave `@` lines inside fenced code blocks alone (a decorator is not an import). */
  skipCodeFences?: boolean;
  /**
   * Keep an import line that was refused, missing, too deep, or past the
   * budget, instead of dropping it. An already-included file is dropped
   * either way: its text is in the prompt once already.
   */
  keepUnresolved?: boolean;
};

export function expandLineImports(text: string, fromRel: string, opts: LineImportOptions, depth = 0): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  const keep = (line: string): void => {
    out.push(line);
    opts.budget.remaining -= line.length + 1;
  };
  for (const line of text.split("\n")) {
    if (opts.skipCodeFences) {
      const marker = FENCE_OPEN.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) {
          fence = undefined;
        }
        keep(line);
        continue;
      }
      if (marker) {
        fence = { char: marker[0] as string, length: marker.length };
        keep(line);
        continue;
      }
    }
    const m = IMPORT_LINE.exec(line);
    if (!m || m[1] === undefined) {
      keep(line);
      continue;
    }
    const unresolved = (): void => {
      if (opts.keepUnresolved) keep(line);
    };
    const resolved = opts.resolve(m[1], fromRel);
    if (resolved === undefined || depth >= opts.maxDepth) {
      unresolved();
      continue;
    }
    if (opts.visited.has(resolved)) continue; // cycle, or included elsewhere already
    const included = opts.read(resolved);
    if (included === undefined || opts.budget.remaining <= 0) {
      unresolved();
      continue;
    }
    opts.visited.add(resolved);
    out.push(expandLineImports(included, resolved, opts, depth + 1));
  }
  return out.join("\n");
}
