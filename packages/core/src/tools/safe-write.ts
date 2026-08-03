import * as fs from "node:fs";
import * as path from "node:path";
import { ToolError } from "./errors.js";
import { resolveForWrite } from "./sandbox.js";

/**
 * The verified in-place write used by every tool that replaces a file's
 * contents.
 *
 * `resolveForWrite` decides whether a path may be written, but between that
 * decision and the write itself the filesystem can change underneath us: the
 * target can be swapped for a symlink pointing outside the workspace, or the
 * parent directory replaced. Opening the file and then re-checking identity
 * through the open descriptor closes that window — a swapped target no longer
 * matches and the write is refused.
 *
 * Extracted from the fs tools so the LSP rename path writes through exactly the
 * same guard rather than a second, weaker implementation.
 */

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Open `resolved` for writing and verify, through the descriptor, that it is
 * still the same file the permission check approved. The caller must close the
 * returned fd.
 *
 * @param expected stat of the file the caller read; the open descriptor must
 *   still refer to it, so a concurrent replacement is rejected instead of
 *   silently overwriting a different file.
 */
export function openVerifiedWrite(
  workspace: string,
  relPath: string,
  resolved: string,
  options: { create: boolean; exclusive: boolean; expected?: fs.Stats },
): number {
  const parent = path.dirname(resolved);
  const parentBefore = fs.statSync(parent);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const flags =
    fs.constants.O_WRONLY |
    noFollow |
    (options.create ? fs.constants.O_CREAT : 0) |
    (options.exclusive ? fs.constants.O_EXCL : 0);
  let fd: number;
  try {
    fd = fs.openSync(resolved, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") {
      throw new ToolError("outside_workspace", `Refusing symlinked write target: ${relPath}`);
    }
    if (code === "EEXIST" && options.exclusive) {
      throw new ToolError("exists", `File already exists: ${relPath} (pass overwrite:true to replace)`);
    }
    throw error;
  }
  try {
    const currentResolved = resolveForWrite(workspace, relPath);
    const opened = fs.fstatSync(fd);
    const current = fs.statSync(currentResolved);
    const parentAfter = fs.statSync(parent);
    if (
      currentResolved !== resolved ||
      !sameFileIdentity(parentBefore, parentAfter) ||
      !sameFileIdentity(opened, current) ||
      (options.expected !== undefined && !sameFileIdentity(opened, options.expected))
    ) {
      throw new ToolError("outside_workspace", `Write target changed during validation: ${relPath}`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** Truncate and rewrite an already-verified descriptor. */
export function replaceFileContents(fd: number, content: string): void {
  fs.ftruncateSync(fd, 0);
  fs.writeFileSync(fd, content, "utf8");
}

/**
 * Replace an existing workspace file's contents through the verified path:
 * open, re-check identity against `expected`, truncate, write, close.
 */
export function replaceExistingFile(
  workspace: string,
  relPath: string,
  resolved: string,
  content: string,
  expected: fs.Stats,
): void {
  const fd = openVerifiedWrite(workspace, relPath, resolved, { create: false, exclusive: false, expected });
  try {
    replaceFileContents(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}
