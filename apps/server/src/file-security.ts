import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolveInsideWorkspace } from "@seekforge/core";

export class FilePathChangedError extends Error {
  constructor() {
    super("file path changed while opening");
    this.name = "FilePathChangedError";
  }
}

export type ResolvedWorkspacePath = {
  workspace: string;
  path: string;
  relative: string;
  requestedRelative: string;
};

function toPosix(path: string): string {
  return path.split(/[/\\]/).join("/");
}

export function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Resolves a workspace path through the shared realpath containment check.
 * With rejectSymlinks, the requested lexical path must also equal the physical
 * path, including for a missing leaf below an existing directory.
 */
export function resolveWorkspacePath(
  workspace: string,
  rel: string,
  rejectSymlinks: boolean,
): ResolvedWorkspacePath {
  const workspaceReal = realpathSync(resolve(workspace));
  const expected = resolve(workspaceReal, rel);
  const physical = resolveInsideWorkspace(workspaceReal, rel);
  if (rejectSymlinks && physical !== expected) throw new FilePathChangedError();
  const fromWorkspace = relative(workspaceReal, physical);
  if (
    fromWorkspace === ".." ||
    fromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(fromWorkspace)
  ) {
    throw new FilePathChangedError();
  }
  return {
    workspace: workspaceReal,
    path: physical,
    relative: toPosix(fromWorkspace),
    requestedRelative: toPosix(relative(workspaceReal, expected)),
  };
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function verifyPathIdentity(
  path: string,
  parentPathStat: Stats,
  filePathStat: Stats,
  parentFdStat: Stats,
  fileFdStat: Stats,
  parentReal: string,
  fileReal: string,
): Stats {
  if (
    parentReal !== dirname(path) ||
    fileReal !== path ||
    !sameFile(parentFdStat, parentPathStat) ||
    !sameFile(fileFdStat, filePathStat)
  ) {
    throw new FilePathChangedError();
  }
  return fileFdStat;
}

export type OpenedVerifiedFile = { parentFd: number; fileFd: number; stat: Stats };

/** Opens a path without following its leaf and binds it to verified path identities. */
export function openVerifiedFile(path: string, flags: number): OpenedVerifiedFile {
  let parentFd: number | undefined;
  let fileFd: number | undefined;
  try {
    parentFd = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    fileFd = openSync(path, flags | constants.O_NOFOLLOW);
    const result = verifyPathIdentity(
      path,
      statSync(dirname(path)),
      statSync(path),
      fstatSync(parentFd),
      fstatSync(fileFd),
      realpathSync(dirname(path)),
      realpathSync(path),
    );
    return { parentFd, fileFd, stat: result };
  } catch (error) {
    if (fileFd !== undefined) closeSync(fileFd);
    if (parentFd !== undefined) closeSync(parentFd);
    throw error;
  }
}

export function closeVerifiedFile(opened: OpenedVerifiedFile): void {
  closeSync(opened.fileFd);
  closeSync(opened.parentFd);
}

export type OpenedVerifiedFileAsync = {
  parentHandle: FileHandle;
  fileHandle: FileHandle;
  stat: Stats;
};

/** Async counterpart used by bounded content search. */
export async function openVerifiedFileAsync(
  path: string,
  flags: number,
): Promise<OpenedVerifiedFileAsync> {
  let parentHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    parentHandle = await open(
      dirname(path),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    fileHandle = await open(path, flags | constants.O_NOFOLLOW);
    const [parentPathStat, filePathStat, parentFdStat, fileFdStat, parentReal, fileReal] =
      await Promise.all([
        stat(dirname(path)),
        stat(path),
        parentHandle.stat(),
        fileHandle.stat(),
        realpath(dirname(path)),
        realpath(path),
      ]);
    const result = verifyPathIdentity(
      path,
      parentPathStat,
      filePathStat,
      parentFdStat,
      fileFdStat,
      parentReal,
      fileReal,
    );
    return { parentHandle, fileHandle, stat: result };
  } catch (error) {
    await fileHandle?.close();
    await parentHandle?.close();
    throw error;
  }
}

export async function closeVerifiedFileAsync(opened: OpenedVerifiedFileAsync): Promise<void> {
  await opened.fileHandle.close();
  await opened.parentHandle.close();
}
