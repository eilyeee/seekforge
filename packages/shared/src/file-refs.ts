/**
 * @path task-reference expansion — the single implementation of what used to
 * be character-identical copies in apps/cli/src/file-refs.ts and
 * apps/tui/src/file-refs.ts (both received the same workspace-escape security
 * fix in parallel; consolidating prevents the next fix from having to land
 * twice).
 *
 * NODE-ONLY: reads the filesystem, so it lives behind the "./file-refs"
 * subpath export and is NOT re-exported from index.ts (the package root must
 * stay browser-safe for the desktop bundle).
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { isSensitiveBasename, isSensitiveRelPath } from "./index.js";

const MAX_PER_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Expands @path tokens in the task: each existing, readable, non-sensitive
 * file inside the workspace is appended to the task as a referenced section.
 * Unknown tokens (e.g. emails, handles) are left untouched.
 */
export function expandFileRefs(task: string, workspace: string): string {
  const tokens = [...new Set(task.match(/@[A-Za-z0-9_\-./]+/g) ?? [])];
  if (tokens.length === 0) return task;

  let root: string;
  try {
    root = realpathSync(workspace);
  } catch {
    return task;
  }

  const sections: string[] = [];
  let total = 0;
  for (const token of tokens) {
    const rel = token.slice(1).replace(/[.,;:]+$/, ""); // strip trailing punctuation
    const abs = resolve(root, rel);
    const requestedRel = relative(root, abs);
    if (isSensitiveBasename(basename(abs)) || isSensitiveRelPath(requestedRel)) continue;
    try {
      const physical = realpathSync(abs);
      if (!isInside(physical, root)) continue;
      const physicalRel = relative(root, physical);
      if (isSensitiveBasename(basename(physical)) || isSensitiveRelPath(physicalRel) || !statSync(physical).isFile()) {
        continue;
      }
      let content = readFileSync(physical, "utf8");
      if (content.includes("\0")) continue; // binary
      if (content.length > MAX_PER_FILE_CHARS) {
        content = `${content.slice(0, MAX_PER_FILE_CHARS)}\n…[truncated]`;
      }
      if (total + content.length > MAX_TOTAL_CHARS) break;
      total += content.length;
      sections.push(`--- Referenced file: ${rel} ---\n${content}`);
    } catch {
      // not a readable file — leave the token as plain text
    }
  }
  return sections.length > 0 ? `${task}\n\n${sections.join("\n\n")}` : task;
}
