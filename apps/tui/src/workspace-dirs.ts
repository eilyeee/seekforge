import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitiveBasename } from "@seekforge/core";
import { scanWorkspaceFiles } from "./files.js";

/**
 * Extra read-only workspace roots for /add-dir. These directories are scanned
 * for the @ file picker and their files can be inlined into tasks via
 * expandExtraFileRefs, but tools never write to them — they only widen what
 * @-references can see.
 */
export type ExtraDirs = { dirs: string[] };

const DEFAULT_TOTAL_SCAN_LIMIT = 2000;
const MAX_PER_FILE_CHARS = 30_000;
const MAX_TOTAL_CHARS = 60_000;

/** True when `child` is `parent` or nested anywhere below it. */
function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Normalizes an /add-dir argument: expands `~`, resolves relative paths
 * against `projectPath`, and requires an existing directory that is NOT
 * inside the project (the project itself is already covered by the regular
 * workspace scan). Returns null when any check fails; never throws.
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
 * Scans every extra dir with the same ignore rules as the workspace scan
 * (delegates to scanWorkspaceFiles per dir) and flattens the results with
 * provenance: `dir` is the extra root, `rel` is relative to that root.
 * `limit` caps the TOTAL across all dirs (default 2000).
 */
export function scanExtraDirs(
  dirs: readonly string[],
  limit = DEFAULT_TOTAL_SCAN_LIMIT,
): Array<{ dir: string; rel: string }> {
  const out: Array<{ dir: string; rel: string }> = [];
  for (const dir of dirs) {
    if (out.length >= limit) break;
    for (const rel of scanWorkspaceFiles(dir, { limit: limit - out.length })) {
      out.push({ dir, rel });
    }
  }
  return out;
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

/** Display lines for /add-dir with no arguments. */
export function formatExtraDirLines(dirs: readonly string[]): string[] {
  if (dirs.length === 0) {
    return ["no extra directories — /add-dir <path> adds one (read-only for @ references)"];
  }
  return dirs.map((d) => `↳ ${d}`);
}
