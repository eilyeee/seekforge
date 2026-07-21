import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;
export const MAX_COMMAND_FILE_BYTES = 1024 * 1024;
export const MAX_EDITOR_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_STATE_FILE_BYTES = 4 * 1024 * 1024;

export class FileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly maxBytes: number,
  ) {
    super(`file exceeds ${maxBytes} bytes: ${path}`);
    this.name = "FileTooLargeError";
  }
}

export function readBufferFdBounded(fd: number, path: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be positive");
  if (!fstatSync(fd).isFile()) throw new Error(`not a regular file: ${path}`);

  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const remaining = maxBytes - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new FileTooLargeError(path, maxBytes);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

export function readTextFdBounded(fd: number, path: string, maxBytes: number): string {
  return readBufferFdBounded(fd, path, maxBytes).toString("utf8");
}

export function readTextFileBounded(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    return readTextFdBounded(fd, path, maxBytes);
  } finally {
    closeSync(fd);
  }
}

export function readBufferFileBounded(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    return readBufferFdBounded(fd, path, maxBytes);
  } finally {
    closeSync(fd);
  }
}
