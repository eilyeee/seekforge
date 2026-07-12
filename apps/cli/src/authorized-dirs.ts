import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Real, case-canonical absolute path. Canonicalizing BOTH the stored dirs and
 * the queried dir makes matching correct on a case-insensitive filesystem
 * (macOS: `/Users/A/Forge` == `/users/a/forge`) and through symlinks (e.g.
 * `/tmp` -> `/private/tmp`), matching the realpath the tool walk root uses.
 * Falls back to a plain resolve for a path that doesn't exist yet (realpathSync
 * throws ENOENT) — that path can't be a real directory to authorize anyway.
 */
function canonical(p: string): string {
  const r = resolve(p);
  try {
    return realpathSync(r);
  } catch {
    return r;
  }
}

/**
 * Per-folder access consent. SeekForge does not silently operate on whatever
 * directory it happens to be launched in — a folder must be authorized once
 * (interactively, or via -y) before the agent reads/edits it. Approved folders
 * are remembered here so later runs don't re-prompt.
 */
export function authorizedStorePath(): string {
  return join(homedir(), ".seekforge", "authorized.json");
}

function readDirs(storePath: string): string[] {
  try {
    const data = JSON.parse(readFileSync(storePath, "utf8")) as { dirs?: unknown };
    return Array.isArray(data.dirs) ? data.dirs.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

function containsPath(ancestor: string, target: string): boolean {
  return target === ancestor || target.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

/** Whether `dir` (or an authorized ancestor of it) has been granted access. */
export function isAuthorizedDir(dir: string, storePath: string = authorizedStorePath()): boolean {
  const target = canonical(dir);
  return readDirs(storePath).some((d) => {
    const a = canonical(d);
    return containsPath(a, target);
  });
}

/** Record `dir` as authorized for future runs (idempotent). */
export function authorizeDir(dir: string, storePath: string = authorizedStorePath()): void {
  const target = canonical(dir);
  const dirs = readDirs(storePath);
  // Skip when already covered by an exact match OR an authorized ANCESTOR — the
  // same containment rule isAuthorizedDir uses — so a redundant subdir entry is
  // never appended (which would bloat the store).
  if (
    dirs.some((d) => {
      const a = canonical(d);
      return containsPath(a, target);
    })
  ) {
    return;
  }
  dirs.push(target);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify({ dirs }, null, 2)}\n`);
}
