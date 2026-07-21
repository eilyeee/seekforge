import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFileBounded } from "@seekforge/shared/bounded-file-read";

export function readTextFileBounded(path: string, maxBytes: number): string {
  return readFileBounded(path, maxBytes).toString("utf8");
}

/** Same-directory atomic replacement so report consumers never observe partial output. */
export function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    const data = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < data.length) {
      const written = writeSync(fd, data, offset, data.length - offset);
      if (written <= 0) throw new Error("report write made no progress");
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
