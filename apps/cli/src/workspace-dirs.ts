// Thin CLI reimplementation of the TUI's /add-dir expansion (the format
// reference is apps/tui/src/workspace-dirs.ts). We do NOT import across apps;
// the CLI only needs normalization + @-reference expansion (no file picker /
// directory scan), so the scan helpers are omitted here.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitiveBasename } from "@seekforge/core";

const MAX_PER_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;

/** True when `child` is `parent` or nested anywhere below it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Normalizes an --add-dir argument: expands `~`, resolves relative paths
 * against `projectPath`, and requires an existing directory that is NOT inside
 * the project (the project is already covered by the regular @-expansion).
 * Returns null when any check fails; never throws.
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
 * each referenced file to the task (caps: 30k per file, 60k total; binary and
 * sensitive basenames skipped). Tokens outside every extra dir are left
 * untouched. Runs AFTER the workspace-level expandFileRefs (idempotent: tokens
 * it already consumed simply won't match files here).
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
