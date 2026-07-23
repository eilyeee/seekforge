import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { acquireSessionLease, SessionBusyError, type SessionLease } from "../agent/session-lease.js";

export const MEMORY_LEASE_ID = "seekforge-memory-store-v1";
const MEMORY_LEASE_TIMEOUT_MS = 30_000;
const waitArray = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

type HeldMemoryLease = {
  depth: number;
  lease: SessionLease;
};

const heldLeases = new Map<string, HeldMemoryLease>();

function workspaceKey(workspace: string): string {
  try {
    return realpathSync.native(workspace);
  } catch {
    return resolve(workspace);
  }
}

function runWithHeldLease<T>(held: HeldMemoryLease, operation: (lease: SessionLease) => T): T {
  held.depth += 1;
  try {
    return operation(held.lease);
  } finally {
    held.depth -= 1;
  }
}

/** Runs one synchronous memory transaction under a workspace-wide, cross-process lease. */
export function withMemoryTransaction<T>(workspace: string, operation: (lease: SessionLease) => T): T {
  const key = workspaceKey(workspace);
  const held = heldLeases.get(key);
  if (held) return runWithHeldLease(held, operation);

  const deadline = Date.now() + MEMORY_LEASE_TIMEOUT_MS;
  let lease: SessionLease;
  for (;;) {
    try {
      lease = acquireSessionLease(key, MEMORY_LEASE_ID);
      break;
    } catch (error) {
      const releaseRace = (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(key);
      if (!(error instanceof SessionBusyError) && !releaseRace) throw error;
      if (Date.now() >= deadline) throw error;
      Atomics.wait(waitArray, 0, 0, 5);
    }
  }

  heldLeases.set(key, { depth: 1, lease });
  try {
    return operation(lease);
  } finally {
    heldLeases.delete(key);
    lease.release();
  }
}

export type TryMemoryTransactionResult<T> = { acquired: true; value: T } | { acquired: false };

/** Non-blocking memory transaction used by idle work: busy means skip this tick. */
export function tryWithMemoryTransaction<T>(
  workspace: string,
  operation: (lease: SessionLease) => T,
): TryMemoryTransactionResult<T> {
  const key = workspaceKey(workspace);
  const held = heldLeases.get(key);
  if (held) return { acquired: true, value: runWithHeldLease(held, operation) };

  let lease: SessionLease;
  try {
    lease = acquireSessionLease(key, MEMORY_LEASE_ID);
  } catch (error) {
    const releaseRace = (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(key);
    if (error instanceof SessionBusyError || releaseRace) return { acquired: false };
    throw error;
  }
  heldLeases.set(key, { depth: 1, lease });
  try {
    return { acquired: true, value: operation(lease) };
  } finally {
    heldLeases.delete(key);
    lease.release();
  }
}
