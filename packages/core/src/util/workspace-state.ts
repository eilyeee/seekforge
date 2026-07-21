import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeAllSync } from "./fs.js";

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export class WorkspaceStateTooLargeError extends Error {
  readonly code = "EFBIG";

  constructor(
    readonly relPath: string,
    readonly limit: number,
  ) {
    super(`workspace state file exceeds ${limit} bytes: ${relPath}`);
    this.name = "WorkspaceStateTooLargeError";
  }
}

const DEFAULT_WORKSPACE_STATE_BYTES = 64 * 1024 * 1024;

function readUtf8Bounded(fd: number, relPath: string, limit: number): string {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > limit) throw new WorkspaceStateTooLargeError(relPath, limit);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function stateTarget(workspace: string, relPath: string, createParents: boolean): string {
  if (
    relPath.length === 0 ||
    isAbsolute(relPath) ||
    relPath.split(/[\\/]/).some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`workspace state path must be canonical and relative: ${relPath}`);
  }
  const root = realpathSync(resolve(workspace));
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    throw new Error(`workspace state path escapes its root: ${relPath}`);
  }

  let current = root;
  const parts = rel.split(sep);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined && createParents) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(current, { throwIfNoEntry: false });
    }
    if (stat === undefined)
      throw Object.assign(new Error(`workspace state parent is missing: ${relPath}`), { code: "ENOENT" });
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
      throw new Error(`workspace state path escapes the workspace or uses a non-physical parent: ${relPath}`);
    }
  }
  return target;
}

/** Reads a workspace-owned state file without following a leaf or parent symlink. */
export function readWorkspaceStateFile(
  workspace: string,
  relPath: string,
  maxBytes = DEFAULT_WORKSPACE_STATE_BYTES,
): string | undefined {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`workspace state byte limit must be a non-negative safe integer: ${maxBytes}`);
  }
  let fd: number | undefined;
  try {
    const target = stateTarget(workspace, relPath, false);
    const parent = dirname(target);
    const parentBefore = statSync(parent);
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (opened.size > maxBytes) {
      throw new WorkspaceStateTooLargeError(relPath, maxBytes);
    }
    const currentTarget = stateTarget(workspace, relPath, false);
    const parentAfter = statSync(parent);
    const current = statSync(currentTarget);
    if (
      currentTarget !== target ||
      !opened.isFile() ||
      !sameIdentity(parentBefore, parentAfter) ||
      !sameIdentity(opened, current)
    ) {
      throw new Error(`workspace state file changed during read: ${relPath}`);
    }
    return readUtf8Bounded(fd, relPath, maxBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Atomically replaces a workspace-owned state file after physical revalidation. */
export function writeWorkspaceStateFileAtomic(workspace: string, relPath: string, data: string): void {
  const target = stateTarget(workspace, relPath, true);
  const parent = dirname(target);
  const parentBefore = statSync(parent);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile() || realpathSync(target) !== target)) {
    throw new Error(`workspace state target must be a physical file: ${relPath}`);
  }

  const temp = join(parent, `.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const openedTemp = fstatSync(fd);
    const currentTarget = stateTarget(workspace, relPath, false);
    const parentAfterOpen = statSync(parent);
    const currentTemp = statSync(temp);
    if (
      currentTarget !== target ||
      !sameIdentity(parentBefore, parentAfterOpen) ||
      !sameIdentity(openedTemp, currentTemp)
    ) {
      throw new Error(`workspace state parent changed during write: ${relPath}`);
    }

    writeAllSync(fd, Buffer.from(data, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    if (stateTarget(workspace, relPath, false) !== target || !sameIdentity(parentBefore, statSync(parent))) {
      throw new Error(`workspace state parent changed before replace: ${relPath}`);
    }
    const current = lstatSync(target, { throwIfNoEntry: false });
    if (current !== undefined && (current.isSymbolicLink() || !current.isFile() || realpathSync(target) !== target)) {
      throw new Error(`workspace state target changed before replace: ${relPath}`);
    }
    renameSync(temp, target);

    let parentFd: number | undefined;
    try {
      parentFd = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fsyncSync(parentFd);
    } catch {
      // Directory fsync is unavailable on some supported filesystems.
    } finally {
      if (parentFd !== undefined) closeSync(parentFd);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}
