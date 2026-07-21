import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`file exceeds ${maxBytes} bytes`);
    this.name = "FileTooLargeError";
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be positive");
}

/** Reads an already-open regular file and rejects initial or concurrent growth past the cap. */
export function readFileDescriptorBounded(fd: number, maxBytes: number): Buffer {
  validateLimit(maxBytes);
  const initial = fstatSync(fd);
  if (!initial.isFile()) throw new Error("file is not a regular file");
  if (initial.size > maxBytes) throw new FileTooLargeError(maxBytes);

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new FileTooLargeError(maxBytes);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

/** Reads a no-follow regular file by path with a hard byte cap. */
export function readFileBounded(path: string, maxBytes: number): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    return readFileDescriptorBounded(fd, maxBytes);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Reads a canonical regular file through verified no-follow descriptors. */
export function readVerifiedFileBounded(root: string, file: string, maxBytes: number): Buffer {
  validateLimit(maxBytes);
  if (!isInside(file, root)) throw new Error("file is outside the approved root");

  const parent = dirname(file);
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const parentFdStat = fstatSync(parentFd);
    const fileFdStat = fstatSync(fileFd);
    if (
      realpathSync(parent) !== parent ||
      realpathSync(file) !== file ||
      !sameFile(parentFdStat, statSync(parent)) ||
      !sameFile(fileFdStat, statSync(file)) ||
      !fileFdStat.isFile()
    ) {
      throw new Error("file path changed while opening");
    }

    const buffer = Buffer.allocUnsafe(maxBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(fileFd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}

/** Verified-path counterpart that rejects rather than truncates an oversized file. */
export function readVerifiedFileExactBounded(root: string, file: string, maxBytes: number): Buffer {
  validateLimit(maxBytes);
  if (!isInside(file, root)) throw new Error("file is outside the approved root");

  const parent = dirname(file);
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const parentFdStat = fstatSync(parentFd);
    const fileFdStat = fstatSync(fileFd);
    if (
      realpathSync(parent) !== parent ||
      realpathSync(file) !== file ||
      !sameFile(parentFdStat, statSync(parent)) ||
      !sameFile(fileFdStat, statSync(file)) ||
      !fileFdStat.isFile()
    ) {
      throw new Error("file path changed while opening");
    }
    return readFileDescriptorBounded(fileFd, maxBytes);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (parentFd !== undefined) closeSync(parentFd);
  }
}
