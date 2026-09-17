/**
 * Finding a running IDE bridge.
 *
 * The editor extension writes `~/.seekforge/ide/<port>.json` (mode 0600) with
 * the port and a bearer token, and removes it on shutdown. The token is the
 * whole authentication, so a lock file is only believed when it is a regular
 * file owned by this user, readable by nobody else, inside a directory nobody
 * else can write to — otherwise another local account could point the TUI at
 * its own server and read every prompt's editor context. A lock whose process
 * is gone is stale and ignored.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { seekforgeHome } from "@seekforge/core";
import { readTextFdBounded } from "../bounded-file.js";

export const IDE_LOCK_VERSION = 1;
const MAX_LOCK_BYTES = 64 * 1024;
const MAX_TOKEN_CHARS = 512;
const MAX_IDE_NAME_CHARS = 64;
const MAX_WORKSPACE_FOLDERS = 64;

export type IdeLock = {
  port: number;
  token: string;
  pid: number;
  ideName: string;
  workspaceFolders: string[];
  /** The lock file it came from. */
  file: string;
};

export type IdeCandidate = IdeLock & {
  /** One of the IDE's workspace folders contains this project. */
  matchesWorkspace: boolean;
};

export type DiscoverySeams = {
  dir?: string;
  uid?: number;
  isAlive?: (pid: number) => boolean;
};

export function ideLockDir(home: string = seekforgeHome()): string {
  return join(home, ".seekforge", "ide");
}

/** `process.kill(pid, 0)` liveness; another user's process counts as not ours. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Owned by `uid` and not readable or writable by group/others (0600-style). */
function privateFile(stat: Stats, uid: number | undefined): boolean {
  if (!stat.isFile()) return false;
  if (uid === undefined) return true;
  return stat.uid === uid && (stat.mode & 0o077) === 0;
}

function trustedDirectory(stat: Stats, uid: number | undefined): boolean {
  if (!stat.isDirectory()) return false;
  if (uid === undefined) return true;
  return stat.uid === uid && (stat.mode & 0o022) === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a parsed lock document; null when any field is off-contract. */
export function parseIdeLock(value: unknown, filePort: number, file: string): IdeLock | null {
  if (!isRecord(value) || value["version"] !== IDE_LOCK_VERSION) return null;
  const { port, token, pid, ideName, workspaceFolders } = value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535 || port !== filePort) {
    return null;
  }
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  if (typeof ideName !== "string") return null;
  if (!Array.isArray(workspaceFolders) || workspaceFolders.length > MAX_WORKSPACE_FOLDERS) return null;
  if (!workspaceFolders.every((folder) => typeof folder === "string" && isAbsolute(folder))) return null;
  return {
    port,
    token,
    pid,
    ideName: ideName.replace(/[\x00-\x1f\x7f]/g, "").slice(0, MAX_IDE_NAME_CHARS) || "IDE",
    workspaceFolders: workspaceFolders as string[],
    file,
  };
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Whether `folder` is `project` or one of its ancestors (separator-aware). */
export function folderContains(folder: string, project: string): boolean {
  const rel = relative(physical(folder), physical(project));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function readLock(dir: string, name: string, uid: number | undefined): IdeLock | string {
  const match = /^([1-9][0-9]{0,4})\.json$/.exec(name);
  if (!match) return `${name}: not a <port>.json lock file`;
  const file = join(dir, name);
  let fd: number | undefined;
  try {
    const before = lstatSync(file);
    if (before.isSymbolicLink() || !privateFile(before, uid)) return `${name}: not a private file owned by you`;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || !privateFile(opened, uid)) {
      return `${name}: changed while being read`;
    }
    const lock = parseIdeLock(JSON.parse(readTextFdBounded(fd, file, MAX_LOCK_BYTES)), Number(match[1]), file);
    return lock ?? `${name}: not a version ${IDE_LOCK_VERSION} IDE lock`;
  } catch (error) {
    return `${name}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Live IDE bridges, the ones whose workspace contains `projectPath` first.
 * `skipped` explains every lock file that was not believed.
 */
export function discoverIdes(
  projectPath: string,
  seams: DiscoverySeams = {},
): { candidates: IdeCandidate[]; skipped: string[] } {
  const dir = seams.dir ?? ideLockDir();
  const uid = seams.uid ?? currentUid();
  const isAlive = seams.isAlive ?? processAlive;
  let names: string[];
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !trustedDirectory(stat, uid)) {
      return { candidates: [], skipped: [`${dir}: not a private directory owned by you`] };
    }
    names = readdirSync(dir).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { candidates: [], skipped: [] };
    return { candidates: [], skipped: [`${dir}: ${(error as Error).message}`] };
  }
  const candidates: IdeCandidate[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const lock = readLock(dir, name, uid);
    if (typeof lock === "string") {
      skipped.push(lock);
      continue;
    }
    if (!isAlive(lock.pid)) continue; // stale: the editor exited without cleaning up
    candidates.push({
      ...lock,
      matchesWorkspace: lock.workspaceFolders.some((folder) => folderContains(folder, projectPath)),
    });
  }
  candidates.sort((a, b) => Number(b.matchesWorkspace) - Number(a.matchesWorkspace) || a.port - b.port);
  return { candidates, skipped };
}
