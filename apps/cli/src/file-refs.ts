import { readFileSync, statSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { isSensitiveBasename } from "@seekforge/core";

const MAX_PER_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;

/**
 * Expands @path tokens in the task: each existing, readable, non-sensitive
 * file inside the workspace is appended to the task as a referenced section.
 * Unknown tokens (e.g. emails, handles) are left untouched.
 */
export function expandFileRefs(task: string, workspace: string): string {
  const tokens = [...new Set(task.match(/@[A-Za-z0-9_\-./]+/g) ?? [])];
  if (tokens.length === 0) return task;

  const sections: string[] = [];
  let total = 0;
  for (const token of tokens) {
    const rel = token.slice(1).replace(/[.,;:]+$/, ""); // strip trailing punctuation
    const abs = resolve(workspace, rel);
    const wsAbs = resolve(workspace);
    // stay inside the workspace — the trailing separator guards against a
    // sibling dir that merely shares the workspace name as a string prefix
    // (e.g. "/w/proj-backup" must not match workspace "/w/proj").
    if (abs !== wsAbs && !abs.startsWith(wsAbs + sep)) continue;
    if (isSensitiveBasename(basename(abs))) continue;
    try {
      if (!statSync(abs).isFile()) continue;
      let content = readFileSync(abs, "utf8");
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
