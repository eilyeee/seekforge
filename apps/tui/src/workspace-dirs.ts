/**
 * TUI-specific /add-dir helpers. The shared halves (normalizeExtraDir +
 * expandExtraFileRefs) moved to @seekforge/shared/workspace-dirs — re-exported
 * here so existing imports keep working; only the file-picker scan and the
 * display formatting are genuinely TUI concerns and stay local.
 */

import { scanWorkspaceFiles } from "./files.js";

export { expandExtraFileRefs, normalizeExtraDir } from "@seekforge/shared/workspace-dirs";

/**
 * Extra read-only workspace roots for /add-dir. These directories are scanned
 * for the @ file picker and their files can be inlined into tasks via
 * expandExtraFileRefs, but tools never write to them — they only widen what
 * @-references can see.
 */
export type ExtraDirs = { dirs: string[] };

const DEFAULT_TOTAL_SCAN_LIMIT = 2000;

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

/** Display lines for /add-dir with no arguments. */
export function formatExtraDirLines(dirs: readonly string[]): string[] {
  if (dirs.length === 0) {
    return ["no extra directories — /add-dir <path> adds one (read-only for @ references)"];
  }
  return dirs.map((d) => `↳ ${d}`);
}
