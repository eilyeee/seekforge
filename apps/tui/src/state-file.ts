import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

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
    fileFd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    verifyStateFile(dir, dirFd, file, fileFd);
    return readFileSync(fileFd, "utf8");
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    closeSync(dirFd);
  }
}

export function writeStateFile(path: string, data: string): void {
  const { dir, file } = statePath(path, true);
  const dirFd = openStateDirectory(dir);
  let fileFd: number | undefined;
  try {
    const existing = lstatSync(file, { throwIfNoEntry: false });
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new Error(`TUI state path is not a regular file: ${file}`);
    }
    try {
      fileFd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        fileFd = openSync(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (openError) {
        if ((openError as NodeJS.ErrnoException).code === "ELOOP") {
          throw new Error(`TUI state path became a symlink: ${file}`);
        }
        throw openError;
      }
    }

    // Bind both pathname components to the descriptors before mutating data.
    // Once verified, a later directory rename cannot redirect descriptor I/O.
    verifyStateFile(dir, dirFd, file, fileFd);
    ftruncateSync(fileFd, 0);
    writeFileSync(fileFd, data, "utf8");
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    closeSync(dirFd);
  }
}
