import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

/** Whether `dir` (or an authorized ancestor of it) has been granted access. */
export function isAuthorizedDir(dir: string, storePath: string = authorizedStorePath()): boolean {
  const target = resolve(dir);
  return readDirs(storePath).some((d) => {
    const a = resolve(d);
    return target === a || target.startsWith(`${a}/`);
  });
}

/** Record `dir` as authorized for future runs (idempotent). */
export function authorizeDir(dir: string, storePath: string = authorizedStorePath()): void {
  const target = resolve(dir);
  const dirs = readDirs(storePath);
  if (dirs.some((d) => resolve(d) === target)) return;
  dirs.push(target);
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, `${JSON.stringify({ dirs }, null, 2)}\n`);
}
