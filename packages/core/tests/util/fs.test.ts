import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { writeAllSync, writeFileAtomic } from "../../src/util/fs.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "seekforge-fs-test-"));
}

/** Names of leftover temp files (`.<basename>.<uuid>.tmp`) in a directory. */
function tempFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

describe("writeFileAtomic", () => {
  it("retries short writes until every byte is consumed", () => {
    const source = Buffer.from("abcdef");
    const chunks: Buffer[] = [];
    writeAllSync(1, source, (_fd, buffer, offset, length) => {
      const written = Math.min(2, length);
      chunks.push(Buffer.from(buffer).subarray(offset, offset + written));
      return written;
    });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("abcdef");
  });

  it("rejects a writer that makes no progress", () => {
    expect(() => writeAllSync(1, Buffer.from("x"), () => 0)).toThrow(/no progress/);
  });

  it("writes the data to a fresh file", () => {
    const dir = makeDir();
    const target = path.join(dir, "data.txt");
    writeFileAtomic(target, "hello\n");
    expect(fs.readFileSync(target, "utf8")).toBe("hello\n");
  });

  it("overwrites an existing file in full", () => {
    const dir = makeDir();
    const target = path.join(dir, "data.txt");
    fs.writeFileSync(target, "old contents that are much longer\n");
    writeFileAtomic(target, "new\n");
    expect(fs.readFileSync(target, "utf8")).toBe("new\n");
  });

  it("leaves no temp file behind after a successful write", () => {
    const dir = makeDir();
    const target = path.join(dir, "data.txt");
    writeFileAtomic(target, "content\n");
    expect(tempFiles(dir)).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual(["data.txt"]);
  });

  it("writes the file with owner-only (0o600) permissions", () => {
    const dir = makeDir();
    const target = path.join(dir, "secret.txt");
    writeFileAtomic(target, "s3cr3t\n");
    // The renamed temp keeps its 0o600 mode: no group/other bits set.
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("cleans up the temp file when the rename fails", () => {
    const dir = makeDir();
    // Target is a NON-EMPTY directory: renameSync(temp, target) fails, so the
    // finally-block must still remove the temp file.
    const target = path.join(dir, "conflict");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "child"), "x");
    expect(() => writeFileAtomic(target, "data\n")).toThrow();
    expect(tempFiles(dir)).toEqual([]);
  });

  it("leaves the previous file intact and drops no temp when the write fails", () => {
    const dir = makeDir();
    const target = path.join(dir, "data.txt");
    writeFileAtomic(target, "good\n");
    // Make the directory read-only so the temp write fails with EACCES. The
    // original file must survive untouched and no temp may linger.
    fs.chmodSync(dir, 0o500);
    try {
      expect(() => writeFileAtomic(target, "partial")).toThrow();
    } finally {
      fs.chmodSync(dir, 0o700);
    }
    expect(fs.readFileSync(target, "utf8")).toBe("good\n");
    expect(tempFiles(dir)).toEqual([]);
  });
});
