/**
 * Extra read-only directory support (`/add-dir` in the TUI, `--add-dir` in the
 * CLI) — the genuinely shared half of what used to be parallel copies in
 * apps/tui/src/workspace-dirs.ts and apps/cli/src/workspace-dirs.ts:
 * normalization of an extra-dir argument plus @-reference expansion against
 * those dirs. App-specific extras stay in the apps (the TUI keeps its
 * scanExtraDirs file-picker scan and formatExtraDirLines display helper).
 *
 * NODE-ONLY: reads the filesystem, so it lives behind the "./workspace-dirs"
 * subpath export and is NOT re-exported from index.ts (the package root must
 * stay browser-safe for the desktop bundle).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitiveBasename } from "./index.js";

const MAX_PER_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;

/** True when `child` is `parent` or nested anywhere below it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Normalizes an /add-dir (TUI) or --add-dir (CLI) argument: expands `~`,
 * resolves relative paths against `projectPath`, and requires an existing
 * directory that is NOT inside the project (the project itself is already
 * covered by the regular workspace scan / @-expansion). Returns null when any
 * check fails; never throws.
 */
export function normalizeExtraDir(input: string, projectPath: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  let expanded = trimmed;
  if (expanded === "~") expanded = os.homedir();
  else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
  const abs = path.resolve(projectPath, expanded);
  try {
    if (!fs.statSync(abs).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isInside(abs, path.resolve(projectPath))) return null;
  return abs;
}

/**
 * Expands @path tokens that resolve INSIDE one of the extra dirs, appending
 * each referenced file to the task (same caps as file-refs.ts: 30k per file,
 * 60k total; binary and sensitive basenames skipped). Tokens that resolve
 * outside every extra dir are left untouched. Designed to run AFTER the
 * workspace-level expandFileRefs — tokens it already consumed simply will not
 * match files here, so the pass is idempotent.
 */
export function expandExtraFileRefs(task: string, dirs: readonly string[]): string {
  if (dirs.length === 0) return task;
  const tokens = [...new Set(task.match(/@[A-Za-z0-9_\-./~]+/g) ?? [])];
  if (tokens.length === 0) return task;

  const roots = dirs.map((d) => path.resolve(d));
  const sections: string[] = [];
  let total = 0;
  for (const token of tokens) {
    let ref = token.slice(1).replace(/[.,;:]+$/, ""); // strip trailing punctuation
    if (ref === "~") ref = os.homedir();
    else if (ref.startsWith("~/")) ref = path.join(os.homedir(), ref.slice(2));
    for (const root of roots) {
      const abs = path.isAbsolute(ref) ? path.resolve(ref) : path.resolve(root, ref);
      if (!isInside(abs, root)) continue; // never read outside the extra dirs
      if (isSensitiveBasename(path.basename(abs))) break;
      try {
        if (!fs.statSync(abs).isFile()) continue;
        let content = fs.readFileSync(abs, "utf8");
        if (content.includes("\0")) break; // binary
        if (content.length > MAX_PER_FILE_CHARS) {
          content = `${content.slice(0, MAX_PER_FILE_CHARS)}\n…[truncated]`;
        }
        if (total + content.length > MAX_TOTAL_CHARS) return appendSections(task, sections);
        total += content.length;
        sections.push(`--- Referenced file: ${abs} ---\n${content}`);
        break; // first matching dir wins
      } catch {
        // not a readable file under this root — try the next root
      }
    }
  }
  return appendSections(task, sections);
}

function appendSections(task: string, sections: readonly string[]): string {
  return sections.length > 0 ? `${task}\n\n${sections.join("\n\n")}` : task;
}
