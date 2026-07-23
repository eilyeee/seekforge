/**
 * Lifecycle-owned idle scheduler for deterministic project-memory maintenance.
 *
 * A workspace session guard is acquired before maintenance: existing Agent or
 * Loop runs make the check a no-op, while new runs cannot start until the short
 * synchronous maintenance transaction releases the guard.
 */

import type { MemoryMaintenanceConfig } from "@seekforge/shared";
import {
  maybeMaintainProjectMemory,
  resolveMemoryMaintenanceConfig,
  type MemoryMaintenanceOutcome,
} from "../memory/index.js";
import { tryWithMemoryTransaction } from "../memory/lease.js";
import { acquireWorkspaceSessionGuardForLease, SessionBusyError } from "./session-lease.js";

export const DEFAULT_MEMORY_IDLE_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_MEMORY_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type IdleMemoryMaintenanceTarget = {
  workspace: string;
  /** Re-read on every check so long-lived servers observe settings changes. */
  getConfig: () => MemoryMaintenanceConfig | undefined;
  /** Optional process-local idle signal, checked before and after the guard. */
  isIdle?: () => boolean;
};

export type IdleMemoryMaintenanceOutcome = MemoryMaintenanceOutcome | { status: "busy" };

export type IdleMemoryMaintenanceResult = {
  workspace: string;
  outcome: IdleMemoryMaintenanceOutcome;
};

export type MemoryMaintenanceScheduler = {
  /** Runs one synchronous idle check over the current target set. */
  checkNow(): IdleMemoryMaintenanceResult[];
  /** Cancels the next check. Idempotent; checkNow becomes a no-op. */
  dispose(): void;
};

export type MemoryMaintenanceSchedulerOptions = {
  targets: () => Iterable<IdleMemoryMaintenanceTarget>;
  initialDelayMs?: number;
  intervalMs?: number;
  /** Injectable timer hooks keep lifecycle behavior deterministic in tests. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Optional observability hook; failures are isolated from the scheduler. */
  onResults?: (results: IdleMemoryMaintenanceResult[]) => void;
};

function timerDelay(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved > MAX_TIMER_DELAY_MS || (allowZero ? resolved < 0 : resolved <= 0)) {
    throw new RangeError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return resolved;
}

function defaultSchedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(error: unknown): IdleMemoryMaintenanceOutcome {
  return { status: "failed", error: errorMessage(error) };
}

function runTarget(target: IdleMemoryMaintenanceTarget): IdleMemoryMaintenanceOutcome {
  let config: ReturnType<typeof resolveMemoryMaintenanceConfig>;
  try {
    config = resolveMemoryMaintenanceConfig(target.getConfig());
  } catch (error) {
    return failed(error);
  }
  if (!config.enabled) return { status: "disabled" };

  try {
    if (target.isIdle && !target.isIdle()) return { status: "busy" };
  } catch (error) {
    return failed(error);
  }

  try {
    const attempt = tryWithMemoryTransaction(target.workspace, (memoryLease): IdleMemoryMaintenanceOutcome => {
      let guard: ReturnType<typeof acquireWorkspaceSessionGuardForLease>;
      try {
        guard = acquireWorkspaceSessionGuardForLease(target.workspace, memoryLease);
      } catch (error) {
        return error instanceof SessionBusyError ? ({ status: "busy" } as const) : failed(error);
      }
      try {
        // Local state may have changed while the cross-process guard was
        // acquired. New persisted sessions are now blocked by the guard.
        if (target.isIdle && !target.isIdle()) return { status: "busy" };
        return maybeMaintainProjectMemory(target.workspace, config);
      } finally {
        guard.release();
      }
    });
    return attempt.acquired ? attempt.value : { status: "busy" };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Starts a recurring idle scheduler. Each tick enumerates targets again, so a
 * server can add/remove workspaces and reload user configuration without a
 * restart. Checks never overlap and every scheduled timer is lifecycle-owned.
 */
export function createMemoryMaintenanceScheduler(
  options: MemoryMaintenanceSchedulerOptions,
): MemoryMaintenanceScheduler {
  const initialDelayMs = timerDelay(
    options.initialDelayMs,
    DEFAULT_MEMORY_IDLE_INITIAL_DELAY_MS,
    "initialDelayMs",
    true,
  );
  const intervalMs = timerDelay(options.intervalMs, DEFAULT_MEMORY_IDLE_CHECK_INTERVAL_MS, "intervalMs", false);
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let disposed = false;
  let checking = false;
  let timer: unknown;

  const checkNow = (): IdleMemoryMaintenanceResult[] => {
    if (disposed || checking) return [];
    checking = true;
    try {
      let targets: IdleMemoryMaintenanceTarget[];
      try {
        targets = [...options.targets()];
      } catch {
        return [];
      }
      const results = targets.map((target) => ({ workspace: target.workspace, outcome: runTarget(target) }));
      try {
        options.onResults?.(results);
      } catch {
        // Observability must never stop housekeeping or its next scheduled tick.
      }
      return results;
    } finally {
      checking = false;
    }
  };

  const scheduleNext = (delayMs: number): void => {
    if (disposed) return;
    timer = schedule(() => {
      timer = undefined;
      checkNow();
      scheduleNext(intervalMs);
    }, delayMs);
  };
  scheduleNext(initialDelayMs);

  return {
    checkNow,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
    },
  };
}
