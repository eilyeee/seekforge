import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Reads a canonical regular file through verified no-follow descriptors. */
export function readVerifiedFileBounded(root: string, file: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be positive");
  if (!isInside(file, root)) throw new Error("file is outside the approved root");

  const parent = dirname(file);
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
