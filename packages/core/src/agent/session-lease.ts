import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FileTooLargeError, readUtf8FileBoundedSync } from "../util/fs.js";

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Outside the persisted session-id grammar, so a real session can never
// collide with the workspace-wide maintenance guard.
const WORKSPACE_GUARD_ID = "@workspace-operation";
const MALFORMED_LEASE_GRACE_MS = 30_000;
const MAX_LEASE_OWNER_BYTES = 16 * 1024;
const MAX_PROC_STAT_BYTES = 64 * 1024;
const localLeases = new Map<string, string>();

export class SessionBusyError extends Error {
  readonly code = "session_busy";

  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} is already running or being modified`);
    this.name = "SessionBusyError";
  }
}

export type SessionLease = {
  readonly workspace: string;
  readonly sessionId: string;
  readonly token: string;
  release: () => void;
};

type LeaseSnapshot = { signature: string; alive: boolean };

function requireSessionId(sessionId: string): void {
  if (sessionId === WORKSPACE_GUARD_ID) return;
  if (!SESSION_ID_RE.test(sessionId) || sessionId.includes("..")) {
    throw new Error(`Invalid session id: ${sessionId}`);
  }
}

function workspaceRoot(workspace: string): string {
  try {
    return realpathSync.native(workspace);
  } catch {
    return resolve(workspace);
  }
}

function leaseKey(workspace: string, sessionId: string): string {
  return `${workspaceRoot(workspace)}\0${sessionId}`;
}

export function sessionLeasesRoot(workspace: string): string {
  const digest = createHash("sha256").update(workspaceRoot(workspace)).digest("hex");
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  return join(realpathSync.native(tmpdir()), `seekforge-${uid}-session-leases`, digest);
}

function validatePrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe session lease path: ${path}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Session lease path is owned by another user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) throw new Error(`Session lease path permissions must be 0700: ${path}`);
  if (realpathSync.native(path) !== path) throw new Error(`Unsafe session lease path: ${path}`);
}

function ensurePrivateDirectory(path: string, create: boolean): boolean {
  try {
    validatePrivateDirectory(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!create) return false;
  }
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  validatePrivateDirectory(path);
  return true;
}

function validateLeasesRoot(workspace: string, create: boolean): string | undefined {
  const root = sessionLeasesRoot(workspace);
  const parent = resolve(root, "..");
  if (!ensurePrivateDirectory(parent, create)) return undefined;
  if (!ensurePrivateDirectory(root, create)) return undefined;
  return root;
}

function leaseDir(workspace: string, sessionId: string): string {
  requireSessionId(sessionId);
  return join(sessionLeasesRoot(workspace), `${sessionId}.lock`);
}

function recoveryDir(workspace: string, sessionId: string): string {
  return `${leaseDir(workspace, sessionId)}.recovery`;
}

function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readUtf8FileBoundedSync(`/proc/${pid}/stat`, MAX_PROC_STAT_BYTES);
      const closeParen = stat.lastIndexOf(")");
      const fields = stat.slice(closeParen + 2).split(" ");
      return fields[19] ? `linux:${fields[19]}` : undefined;
    }
    if (process.platform === "darwin" || process.platform === "freebsd") {
      const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
      if (started) return `${process.platform}:${started}`;
    }
  } catch {
    // A PID liveness check still provides a conservative fallback below.
  }
  if (pid === process.pid) return `portable:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;
  return undefined;
}

const selfProcessIdentity = processIdentity(process.pid);

function ownerPayload(token: string): string {
  return JSON.stringify({
    version: 1,
    pid: process.pid,
    token,
    processIdentity: selfProcessIdentity,
    createdAt: new Date().toISOString(),
  });
}

function writeOwner(dir: string, token: string): void {
  const target = join(dir, "owner.json");
  const fd = openSync(target, "wx", 0o600);
  try {
    writeFileSync(fd, ownerPayload(token), "utf8");
  } finally {
    closeSync(fd);
  }
}

function snapshot(dir: string): LeaseSnapshot {
  validatePrivateDirectory(dir);
  let content: string;
  try {
    content = readUtf8FileBoundedSync(join(dir, "owner.json"), MAX_LEASE_OWNER_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const mtime = statSync(dir).mtimeMs;
      return { signature: `malformed:${mtime}`, alive: Date.now() - mtime < MALFORMED_LEASE_GRACE_MS };
    }
    if (error instanceof FileTooLargeError) {
      const stat = statSync(join(dir, "owner.json"));
      return {
        signature: `oversized:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
        alive: Date.now() - stat.mtimeMs < MALFORMED_LEASE_GRACE_MS,
      };
    }
    throw error;
  }

  let owner: { pid?: unknown; token?: unknown; processIdentity?: unknown; createdAt?: unknown };
  try {
    owner = JSON.parse(content) as typeof owner;
  } catch {
    const mtime = statSync(join(dir, "owner.json")).mtimeMs;
    return { signature: content, alive: Date.now() - mtime < MALFORMED_LEASE_GRACE_MS };
  }
  if (
    !Number.isInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== "string" ||
    typeof owner.processIdentity !== "string" ||
    typeof owner.createdAt !== "string" ||
    !Number.isFinite(Date.parse(owner.createdAt))
  ) {
    const mtime = statSync(join(dir, "owner.json")).mtimeMs;
    return { signature: content, alive: Date.now() - mtime < MALFORMED_LEASE_GRACE_MS };
  }

  try {
    process.kill(owner.pid as number, 0);
    const identity = processIdentity(owner.pid as number);
    return { signature: content, alive: identity === undefined || identity === owner.processIdentity };
  } catch (error) {
    return { signature: content, alive: (error as NodeJS.ErrnoException).code !== "ESRCH" };
  }
}

function sameSnapshot(dir: string, expected: LeaseSnapshot): boolean {
  try {
    return snapshot(dir).signature === expected.signature;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function removeStaleRecovery(workspace: string, sessionId: string): boolean {
  const recovery = recoveryDir(workspace, sessionId);
  if (!existsSync(recovery)) return true;
  const current = snapshot(recovery);
  if (current.alive) return false;
  if (sameSnapshot(recovery, current)) rmSync(recovery, { recursive: true, force: true });
  return !existsSync(recovery);
}

function removeStaleLease(workspace: string, sessionId: string, expected: LeaseSnapshot): boolean {
  const target = leaseDir(workspace, sessionId);
  const recovery = recoveryDir(workspace, sessionId);
  const recoveryToken = randomUUID();
  try {
    mkdirSync(recovery, { mode: 0o700 });
    try {
      writeOwner(recovery, recoveryToken);
    } catch (error) {
      rmSync(recovery, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }

  try {
    if (!sameSnapshot(target, expected)) return false;
    const current = snapshot(target);
    if (current.alive) return false;
    rmSync(target, { recursive: true, force: true });
    return true;
  } finally {
    try {
      const owner = JSON.parse(readUtf8FileBoundedSync(join(recovery, "owner.json"), MAX_LEASE_OWNER_BYTES)) as {
        token?: unknown;
      };
      if (owner.token === recoveryToken) rmSync(recovery, { recursive: true, force: true });
    } catch {
      // A missing or replaced recovery marker is no longer ours.
    }
  }
}

function acquireLease(workspace: string, sessionId: string): SessionLease {
  requireSessionId(sessionId);
  const root = workspaceRoot(workspace);
  const key = leaseKey(root, sessionId);
  if (localLeases.has(key)) throw new SessionBusyError(sessionId);
  if (sessionId !== WORKSPACE_GUARD_ID && isSessionRunActive(root, WORKSPACE_GUARD_ID)) {
    throw new SessionBusyError(sessionId);
  }
  validateLeasesRoot(root, true);

  const target = leaseDir(root, sessionId);
  const token = randomUUID();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!removeStaleRecovery(root, sessionId)) throw new SessionBusyError(sessionId);
    try {
      mkdirSync(target, { mode: 0o700 });
      try {
        writeOwner(target, token);
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw error;
      }
      localLeases.set(key, token);
      let released = false;
      const lease: SessionLease = {
        workspace: root,
        sessionId,
        token,
        release: () => {
          if (released) return;
          try {
            validatePrivateDirectory(target);
            const owner = JSON.parse(readUtf8FileBoundedSync(join(target, "owner.json"), MAX_LEASE_OWNER_BYTES)) as {
              token?: unknown;
            };
            if (owner.token !== token) {
              released = true;
              if (localLeases.get(key) === token) localLeases.delete(key);
              return;
            }
            rmSync(target, { recursive: true });
            released = true;
            if (localLeases.get(key) === token) localLeases.delete(key);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(target)) {
              released = true;
              if (localLeases.get(key) === token) localLeases.delete(key);
            }
            // Keep ownership live so a later release() can retry cleanup.
          }
        },
      };
      if (sessionId !== WORKSPACE_GUARD_ID && isSessionRunActive(root, WORKSPACE_GUARD_ID)) {
        lease.release();
        throw new SessionBusyError(sessionId);
      }
      return lease;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = snapshot(target);
      if (current.alive) throw new SessionBusyError(sessionId);
      if (!removeStaleLease(root, sessionId, current)) continue;
    }
  }
  throw new SessionBusyError(sessionId);
}

/** Acquire an exclusive, cross-process lease for one persisted session. */
export function acquireSessionLease(workspace: string, sessionId: string): SessionLease {
  if (sessionId === WORKSPACE_GUARD_ID) throw new Error(`Invalid session id: ${sessionId}`);
  return acquireLease(workspace, sessionId);
}

export function assertSessionLease(lease: SessionLease, workspace: string, sessionId: string): void {
  if (
    lease.workspace !== workspaceRoot(workspace) ||
    lease.sessionId !== sessionId ||
    localLeases.get(leaseKey(workspace, sessionId)) !== lease.token
  ) {
    throw new Error(`Invalid session lease: ${sessionId}`);
  }
}

/** True while any live process owns this persisted session. */
export function isSessionRunActive(workspace: string, sessionId: string): boolean {
  requireSessionId(sessionId);
  if (localLeases.has(leaseKey(workspace, sessionId))) return true;
  if (!removeStaleRecovery(workspace, sessionId)) return true;
  const target = leaseDir(workspace, sessionId);
  try {
    const current = snapshot(target);
    if (current.alive) return true;
    removeStaleLease(workspace, sessionId, current);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** True while any live process owns a persisted session in this workspace. */
export function hasActiveSessionRuns(workspace: string): boolean {
  return hasActiveSessionRunsExcept(workspace);
}

function hasActiveSessionRunsExcept(workspace: string, excludedSessionId?: string): boolean {
  const prefix = `${workspaceRoot(workspace)}\0`;
  if ([...localLeases.keys()].some((key) => key.startsWith(prefix) && key.slice(prefix.length) !== excludedSessionId))
    return true;
  let names: string[];
  try {
    const root = validateLeasesRoot(workspace, false);
    if (!root) return false;
    names = readdirSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    const match = /^(.+)\.lock(?:\.recovery)?$/.exec(name);
    if (!match?.[1] || (match[1] !== WORKSPACE_GUARD_ID && (!SESSION_ID_RE.test(match[1]) || match[1].includes(".."))))
      return true;
    if (match[1] === excludedSessionId) continue;
    if (isSessionRunActive(workspace, match[1])) return true;
  }
  return false;
}

/**
 * Blocks new session runs in a workspace while a destructive maintenance
 * operation verifies that no existing runs remain.
 */
export function acquireWorkspaceSessionGuard(workspace: string): SessionLease {
  const guard = acquireLease(workspace, WORKSPACE_GUARD_ID);
  if (hasActiveSessionRunsExcept(workspace, WORKSPACE_GUARD_ID)) {
    guard.release();
    throw new SessionBusyError(WORKSPACE_GUARD_ID);
  }
  return guard;
}
