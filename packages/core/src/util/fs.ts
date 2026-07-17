import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Read a UTF-8 file, or undefined when it is missing/unreadable. */
export function readFileIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Atomically (re)writes a whole file: write a uniquely-named sibling temp file,
 * then `rename` it over the target. The rename is atomic on POSIX, so a reader
 * (or a process killed mid-write) never sees a truncated/partial file, and two
 * concurrent writers can't interleave into a corrupt result. Mirrors the atomic
 * write in agent/loop-state.ts `saveLoopState` (0o600, temp cleaned in finally).
 *
 * Only for full-file rewrites — append-only writes (`appendFileSync`) must NOT
 * use this, as it would replace rather than extend the file. The caller is
 * responsible for creating the parent directory first (e.g. via `mkdirSync`).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const temp = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, data, { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temp, filePath);
  } finally {
    rmSync(temp, { force: true });
  }
}
