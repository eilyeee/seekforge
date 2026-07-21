import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { MAX_STATE_FILE_BYTES, readTextFdBounded } from "./bounded-file.js";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function statePath(path: string, create: boolean): { dir: string; file: string } {
  const requestedDir = dirname(path);
  const name = basename(path);
  const dirName = basename(requestedDir);
  if (!dirName || dirName === "." || dirName === ".." || !name || name === "." || name === "..") {
    throw new Error(`not a TUI state file: ${path}`);
  }

  const root = realpathSync(dirname(requestedDir));
  const dir = join(root, dirName);
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`TUI state directory is not real: ${dir}`);
  } catch (error) {
    if (!missing(error) || !create) throw error;
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
  }
  return { dir, file: join(dir, name) };
}

function openStateDirectory(dir: string): number {
  const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    verifyStateDirectory(dir, fd);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function verifyStateDirectory(dir: string, fd: number): void {
  const opened = fstatSync(fd);
  const current = lstatSync(dir);
  if (
    !opened.isDirectory() ||
    current.isSymbolicLink() ||
    !current.isDirectory() ||
    !sameIdentity(opened, statSync(dir)) ||
    realpathSync(dir) !== dir
  ) {
    throw new Error(`TUI state directory changed while open: ${dir}`);
  }
}

function verifyStateFile(dir: string, dirFd: number, file: string, fileFd: number): void {
  verifyStateDirectory(dir, dirFd);
  const opened = fstatSync(fileFd);
  const current = lstatSync(file);
  if (
    !opened.isFile() ||
    current.isSymbolicLink() ||
    !current.isFile() ||
    !sameIdentity(opened, statSync(file)) ||
    realpathSync(file) !== file
  ) {
    throw new Error(`TUI state path changed while open: ${file}`);
  }
}

export function readStateFile(path: string): string {
  const { dir, file } = statePath(path, false);
  const dirFd = openStateDirectory(dir);
  let fileFd: number | undefined;
  try {
    fileFd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    verifyStateFile(dir, dirFd, file, fileFd);
    return readTextFdBounded(fileFd, file, MAX_STATE_FILE_BYTES);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    closeSync(dirFd);
  }
}

export function writeStateFile(path: string, data: string): void {
  if (Buffer.byteLength(data) > MAX_STATE_FILE_BYTES) {
    throw new Error(`TUI state exceeds ${MAX_STATE_FILE_BYTES} bytes: ${path}`);
  }
  const { dir, file } = statePath(path, true);
  const dirFd = openStateDirectory(dir);
  const existing = lstatSync(file, { throwIfNoEntry: false });
  let tempFd: number | undefined;
  const temp = join(dir, `.${basename(file)}.${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
  try {
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error(`TUI state path is not a regular file: ${file}`);
    }
    tempFd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(tempFd, data, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = undefined;

    verifyStateDirectory(dir, dirFd);
    const current = lstatSync(file, { throwIfNoEntry: false });
    if (
      (existing === undefined && current !== undefined) ||
      (existing !== undefined &&
        (current === undefined || current.isSymbolicLink() || !current.isFile() || !sameIdentity(existing, current)))
    ) {
      throw new Error(`TUI state path changed during write: ${file}`);
    }
    renameSync(temp, file);
    fsyncSync(dirFd);
  } finally {
    if (tempFd !== undefined) closeSync(tempFd);
    try {
      verifyStateDirectory(dir, dirFd);
      rmSync(temp, { force: true });
    } catch {
      // Do not follow a replacement directory during cleanup.
    }
    closeSync(dirFd);
  }
}
