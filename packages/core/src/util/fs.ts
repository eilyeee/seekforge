import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

type SyncWriter = (fd: number, buffer: Uint8Array, offset: number, length: number) => number;

/** Write every byte, retrying short writes and rejecting a zero-progress writer. */
export function writeAllSync(fd: number, data: Uint8Array, writer: SyncWriter = writeSync): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writer(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error("write made no progress");
    offset += written;
  }
}

/** Read a UTF-8 file, or undefined when it is missing/unreadable. */
export function readFileIfExists(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Atomically and DURABLY (re)writes a whole file: write a uniquely-named
 * sibling temp file, fsync it, then `rename` it over the target and fsync the
 * directory. The rename is atomic on POSIX, so a reader never sees a partial
 * file; the fsyncs ensure the bytes (and the rename) actually reach disk before
 * we return, so a power loss can't leave a zero-length/garbage target that every
 * caller then parses fail-closed and silently drops. The single home for plain
 * full-file atomic writes (0o600, temp cleaned in finally); callers like
 * loop-state/trace/subagent-import all route through here. The server's
 * writeProjectFileAtomic additionally adds symlink-TOCTOU guards on the target.
 *
 * Only for full-file rewrites — append-only writes (`appendFileSync`) must NOT
 * use this, as it would replace rather than extend the file. The caller is
 * responsible for creating the parent directory first (e.g. via `mkdirSync`).
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = dirname(filePath);
  const temp = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    const bytes = Buffer.from(data, "utf8");
    writeAllSync(fd, bytes);
    fsyncSync(fd); // flush the data to disk before the rename
    closeSync(fd);
    fd = undefined;
    renameSync(temp, filePath);
    // fsync the directory so the rename entry itself is durable. Best-effort:
    // opening a directory for fsync is not supported on every platform/FS.
    let dirFd: number | undefined;
    try {
      dirFd = openSync(dir, "r");
      fsyncSync(dirFd);
    } catch {
      // directory fsync unsupported here — the data fsync above still holds
    } finally {
      if (dirFd !== undefined) closeSync(dirFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
