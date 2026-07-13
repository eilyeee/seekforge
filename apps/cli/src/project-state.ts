import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function assertPlainDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`project state directory must be a real directory: ${path}`);
  }
}

/** Resolve (and optionally create) the physically contained project state directory. */
export function projectStateDirectory(projectPath: string, create = true): string {
  const root = realpathSync(projectPath);
  const stateDir = join(root, ".seekforge");
  try {
    assertPlainDirectory(stateDir);
  } catch (err) {
    if (!isMissing(err) || !create) throw err;
    try {
      mkdirSync(stateDir, { mode: 0o700 });
    } catch (mkdirErr) {
      if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirErr;
    }
    assertPlainDirectory(stateDir);
  }
  return stateDir;
}

export function projectStateFilePath(projectPath: string, name: string): string {
  if (!name || basename(name) !== name) throw new Error(`invalid project state filename: ${name}`);
  return join(projectStateDirectory(projectPath), name);
}

export function readProjectStateFile(projectPath: string, name: string): string {
  const path = projectStateFilePath(projectPath, name);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** Persist a direct child of `.seekforge` without following directory/file symlinks. */
export function writeProjectStateFile(projectPath: string, name: string, data: string): string {
  const stateDir = projectStateDirectory(projectPath);
  const target = join(stateDir, name);
  if (basename(name) !== name) throw new Error(`invalid project state filename: ${name}`);

  try {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`project state file must be a regular file: ${target}`);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  const token = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const temp = join(stateDir, `.${name}.${token}.tmp`);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    writeFileSync(fd, data, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    assertPlainDirectory(stateDir);
    if (realpathSync(stateDir) !== stateDir) throw new Error(`project state directory changed during write: ${stateDir}`);
    try {
      if (lstatSync(target).isSymbolicLink()) throw new Error(`refusing to replace symlinked project state file: ${target}`);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    renameSync(temp, target);

    const dirFd = openSync(stateDir, constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return target;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      assertPlainDirectory(stateDir);
      if (realpathSync(stateDir) === stateDir) rmSync(temp, { force: true });
    } catch {
      // The state directory changed; do not follow its replacement during cleanup.
    }
  }
}

/** Secure a `.seekforge/<file>` path while retaining the existing path-based API. */
export function writeStatePath(path: string, data: string): string {
  const stateDir = dirname(path);
  if (basename(stateDir) !== ".seekforge") throw new Error(`not a project state path: ${path}`);
  return writeProjectStateFile(dirname(stateDir), basename(path), data);
}
