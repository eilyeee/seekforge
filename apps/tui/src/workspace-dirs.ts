/**
 * TUI-specific /add-dir helpers. The shared halves (normalizeExtraDir +
 * expandExtraFileRefs) moved to @seekforge/shared/workspace-dirs — re-exported
 * here so existing imports keep working; only the file-picker scan and the
 * display formatting are genuinely TUI concerns and stay local.
 */

import { scanWorkspaceFiles } from "./files.js";
import { t } from "./strings.js";

export { expandExtraFileRefs, normalizeExtraDir } from "@seekforge/shared/workspace-dirs";

/**
 * Directories granted for the session by /add-dir and --add-dir. They reach
 * core as `additionalDirectories` (joined with the user config's), so the file
 * tools may read and write there under the workspace's rules; their files can
 * also be inlined into tasks via expandExtraFileRefs.
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

/**
 * Display lines for /add-dir with no arguments: the session's directories,
 * then the user config's `additionalDirectories` (marked), without repeats.
 */
export function formatExtraDirLines(dirs: readonly string[], configured: readonly string[] = []): string[] {
  const fromConfig = configured.filter((dir) => !dirs.includes(dir));
  if (dirs.length === 0 && fromConfig.length === 0) return [t("addDir.none")];
  return [...dirs.map((d) => `↳ ${d}`), ...fromConfig.map((d) => `↳ ${d}  ${t("addDir.fromConfig")}`)];
}
