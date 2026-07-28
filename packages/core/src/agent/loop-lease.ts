import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FileTooLargeError, readUtf8FileBoundedSync } from "../util/fs.js";
import { isRecord } from "../util/guards.js";
import {
  acquireSessionLease,
  acquireSessionLeaseWithPreemption,
  isSessionRunActive,
  type SessionLease,
} from "./session-lease.js";
import { isValidLoopId, loopLockFile, loopStateRoot, requireLoopWorkspace } from "./loop-state-paths.js";

const activeLeases = new Set<string>();
const MALFORMED_LOCK_GRACE_MS = 30_000;
const MAX_LOOP_LOCK_BYTES = 16 * 1024;
const MAX_PROC_STAT_BYTES = 64 * 1024;

export type LoopLease = { release: () => void };

const leaseKey = (workspace: string, loopId: string): string => `${requireLoopWorkspace(workspace)}\0${loopId}`;

function deliveryLeaseId(loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return `loop-delivery-${createHash("sha256").update(loopId).digest("hex").slice(0, 32)}`;
}

/** Cross-process lease for run, delivery, and deletion lifecycle changes. */
export function acquireLoopLifecycleLease(workspace: string, loopId: string, workspaceGuard?: SessionLease): LoopLease {
  return acquireSessionLease(workspace, deliveryLeaseId(loopId), workspaceGuard);
}

/** Foreground lifecycle acquisition that preempts idle recovery and waits for it to yield. */
export function acquireLoopLifecycleLeaseWithPreemption(
  workspace: string,
  loopId: string,
  options: { signal?: AbortSignal; workspaceGuard?: SessionLease } = {},
): Promise<LoopLease> {
  return acquireSessionLeaseWithPreemption(workspace, deliveryLeaseId(loopId), options);
}

/** Returns whether a run, delivery, or deletion currently owns this Loop lifecycle. */
export function isLoopLifecycleActive(workspace: string, loopId: string): boolean {
  return isSessionRunActive(workspace, deliveryLeaseId(loopId));
}

/** @deprecated Use acquireLoopLifecycleLease. */
export const acquireLoopDeliveryLease = acquireLoopLifecycleLease;

/** @deprecated Use isLoopLifecycleActive. */
export const isLoopDeliveryActive = isLoopLifecycleActive;

type LockSnapshot = { content: string; alive: boolean };

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
    // Fall through to the current-process identity when OS inspection is unavailable.
  }
  if (pid === process.pid) return `portable:${Math.floor((Date.now() - process.uptime() * 1_000) / 1_000)}`;
  return undefined;
}

const selfProcessIdentity = processIdentity(process.pid);

function readLockSnapshot(target: string): LockSnapshot {
  let content: string;
  try {
    content = readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES);
  } catch (error) {
    if (!(error instanceof FileTooLargeError)) throw error;
    const stat = statSync(target);
    return {
      content: `oversized:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`,
      alive: Date.now() - stat.mtimeMs < MALFORMED_LOCK_GRACE_MS,
    };
  }
  let owner: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) {
      return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
    }
    owner = parsed;
  } catch {
    return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
  }
  if (
    !Number.isInteger(owner.pid) ||
    (owner.pid as number) <= 0 ||
    typeof owner.token !== "string" ||
    (owner.createdAt !== undefined &&
      (typeof owner.createdAt !== "string" || !Number.isFinite(Date.parse(owner.createdAt))))
  ) {
    return { content, alive: Date.now() - statSync(target).mtimeMs < MALFORMED_LOCK_GRACE_MS };
  }
  try {
    process.kill(owner.pid as number, 0);
    if (typeof owner.processIdentity === "string") {
      const currentIdentity = processIdentity(owner.pid as number);
      if (currentIdentity !== undefined && currentIdentity !== owner.processIdentity) return { content, alive: false };
    }
    return { content, alive: true };
  } catch (error) {
    return { content, alive: (error as NodeJS.ErrnoException).code !== "ESRCH" };
  }
}

function removeStaleLock(target: string, expectedContent: string): boolean {
  try {
    if (readLockSnapshot(target).content !== expectedContent) return false;
    rmSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return true;
  }
}

/** Returns whether a live process-local or filesystem lease owns this loop. */
export function isLoopLeaseActive(workspace: string, loopId: string): boolean {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  if (activeLeases.has(leaseKey(workspace, loopId))) return true;
  const target = loopLockFile(workspace, loopId);
  try {
    return readLockSnapshot(target).alive;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Returns whether any live Loop lease exists in this workspace. */
export function hasActiveLoopLease(workspace: string): boolean {
  const prefix = `${requireLoopWorkspace(workspace)}\0`;
  if ([...activeLeases].some((key) => key.startsWith(prefix))) return true;
  let names: string[];
  try {
    names = readdirSync(loopStateRoot(workspace));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  for (const name of names) {
    const match = /^\.(.+)\.lock$/.exec(name);
    if (!match?.[1]) continue;
    if (!isValidLoopId(match[1])) return true;
    if (isLoopLeaseActive(workspace, match[1])) return true;
  }
  return false;
}

/** Acquires a process- and filesystem-wide Loop run lease. */
export function acquireLoopLease(workspace: string, loopId: string, persist: boolean): LoopLease {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  const key = leaseKey(workspace, loopId);
  if (activeLeases.has(key)) throw new Error(`Loop is already running: ${loopId}`);
  activeLeases.add(key);
  if (!persist)
    return {
      release: () => {
        activeLeases.delete(key);
      },
    };

  try {
    const target = loopLockFile(workspace, loopId);
    mkdirSync(dirname(target), { recursive: true });
    const token = randomUUID();
    const payload = JSON.stringify({
      version: 1,
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
      ...(selfProcessIdentity ? { processIdentity: selfProcessIdentity } : {}),
    });
    const recoveryTarget = `${target}.recovery`;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (existsSync(recoveryTarget)) {
        const recovery = readLockSnapshot(recoveryTarget);
        if (recovery.alive) throw new Error(`Loop lease recovery is already running: ${loopId}`);
        removeStaleLock(recoveryTarget, recovery.content);
        continue;
      }
      try {
        const fd = openSync(target, "wx", 0o600);
        try {
          writeFileSync(fd, payload, "utf8");
        } catch (error) {
          try {
            closeSync(fd);
          } finally {
            rmSync(target, { force: true });
          }
          throw error;
        }
        closeSync(fd);
        if (existsSync(recoveryTarget)) {
          try {
            const owner = JSON.parse(readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES)) as { token?: unknown };
            if (owner.token === token) rmSync(target);
          } catch {
            /* A recovery contender replaced or removed this candidate. */
          }
          continue;
        }
        return {
          release: () => {
            activeLeases.delete(key);
            try {
              const owner = JSON.parse(readUtf8FileBoundedSync(target, MAX_LOOP_LOCK_BYTES)) as { token?: unknown };
              if (owner.token === token) rmSync(target);
            } catch {
              /* A missing/replaced lock no longer belongs to this lease. */
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const snapshot = readLockSnapshot(target);
        if (snapshot.alive) throw new Error(`Loop is already running: ${loopId}`);
        let recoveryFd: number;
        try {
          recoveryFd = openSync(recoveryTarget, "wx", 0o600);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw recoveryError;
        }
        try {
          writeFileSync(recoveryFd, payload, "utf8");
        } finally {
          closeSync(recoveryFd);
        }
        try {
          const current = readLockSnapshot(target);
          if (!current.alive && current.content === snapshot.content) removeStaleLock(target, current.content);
        } catch (recoveryError) {
          if ((recoveryError as NodeJS.ErrnoException).code !== "ENOENT") throw recoveryError;
        } finally {
          try {
            const owner = JSON.parse(readUtf8FileBoundedSync(recoveryTarget, MAX_LOOP_LOCK_BYTES)) as {
              token?: unknown;
            };
            if (owner.token === token) rmSync(recoveryTarget);
          } catch {
            /* A missing/replaced recovery marker no longer belongs to this process. */
          }
        }
      }
    }
    throw new Error(`Could not acquire loop lease: ${loopId}`);
  } catch (error) {
    activeLeases.delete(key);
    throw error;
  }
}
