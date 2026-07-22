import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
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
const DEFAULT_BOUNDED_FILE_BYTES = 16 * 1024 * 1024;

export function readFileIfExists(filePath: string, maxBytes = DEFAULT_BOUNDED_FILE_BYTES): string | undefined {
  try {
    return readUtf8FileBoundedSync(filePath, maxBytes);
  } catch {
    return undefined;
  }
}

export class FileTooLargeError extends Error {
  readonly code = "EFBIG";

  constructor(
    readonly filePath: string,
    readonly limit: number,
  ) {
    super(`file exceeds ${limit} bytes: ${filePath}`);
    this.name = "FileTooLargeError";
  }
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Reads at most `maxBytes` from one physical regular file. The descriptor and
 * pathname are identity-checked so a validation/read swap cannot redirect the
 * operation, and the streaming limit still holds when the file grows mid-read.
 */
export function readFileBoundedSync(filePath: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`file byte limit must be a non-negative safe integer: ${maxBytes}`);
  }
  const parent = dirname(filePath);
  const parentBefore = statSync(parent);
  let fd: number | undefined;
  try {
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new Error(`not a regular file: ${filePath}`);
    if (opened.size > maxBytes) throw new FileTooLargeError(filePath, maxBytes);
    const current = statSync(filePath);
    const parentAfter = statSync(parent);
    if (!sameIdentity(parentBefore, parentAfter) || !sameIdentity(opened, current)) {
      throw new Error(`file changed during validation: ${filePath}`);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw new FileTooLargeError(filePath, maxBytes);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readUtf8FileBoundedSync(filePath: string, maxBytes: number): string {
  return readFileBoundedSync(filePath, maxBytes).toString("utf8");
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
