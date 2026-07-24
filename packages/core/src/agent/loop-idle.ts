import type { LoopResult } from "./auto-loop.js";

export const DEFAULT_LOOP_IDLE_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_LOOP_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type IdleLoopRecoveryTarget = {
  workspace: string;
  /** Return undefined when the workspace stopped being idle before recovery began. */
  recover: (signal: AbortSignal) => Promise<LoopResult[] | undefined>;
};

export type IdleLoopRecoveryOutcome =
  | { status: "completed"; results: LoopResult[] }
  | { status: "busy" }
  | { status: "failed"; error: string };

export type IdleLoopRecoveryResult = {
  workspace: string;
  outcome: IdleLoopRecoveryOutcome;
};

export type LoopRecoveryScheduler = {
  /** Runs one non-overlapping check over the current target set. */
  checkNow(): Promise<IdleLoopRecoveryResult[]>;
  /** Cancels the next check and aborts any recovery owned by this scheduler. */
  dispose(): void;
};

export type LoopRecoverySchedulerOptions = {
  targets: () => Iterable<IdleLoopRecoveryTarget>;
  initialDelayMs?: number;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Observability failures are isolated from recovery and future ticks. */
  onResults?: (results: IdleLoopRecoveryResult[]) => void;
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

/**
 * Starts a lifecycle-owned scheduler for opt-in background Loop recovery.
 * Workspaces are processed in order to avoid an idle tick creating an
 * unbounded burst of concurrent model calls.
 */
export function createLoopRecoveryScheduler(options: LoopRecoverySchedulerOptions): LoopRecoveryScheduler {
  const initialDelayMs = timerDelay(options.initialDelayMs, DEFAULT_LOOP_IDLE_INITIAL_DELAY_MS, "initialDelayMs", true);
  const intervalMs = timerDelay(options.intervalMs, DEFAULT_LOOP_IDLE_CHECK_INTERVAL_MS, "intervalMs", false);
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const controller = new AbortController();
  let disposed = false;
  let checking = false;
  let timer: unknown;

  const checkNow = async (): Promise<IdleLoopRecoveryResult[]> => {
    if (disposed || checking) return [];
    checking = true;
    try {
      let targets: IdleLoopRecoveryTarget[];
      try {
        targets = [...options.targets()];
      } catch {
        return [];
      }

      const results: IdleLoopRecoveryResult[] = [];
      for (const target of targets) {
        if (controller.signal.aborted) break;
        try {
          const recovered = await target.recover(controller.signal);
          results.push({
            workspace: target.workspace,
            outcome: recovered === undefined ? { status: "busy" } : { status: "completed", results: recovered },
          });
        } catch (error) {
          if (controller.signal.aborted) break;
          results.push({ workspace: target.workspace, outcome: { status: "failed", error: errorMessage(error) } });
        }
      }

      if (!disposed) {
        try {
          options.onResults?.(results);
        } catch {
          // Observability must never stop recovery or its next scheduled tick.
        }
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
      void checkNow().finally(() => scheduleNext(intervalMs));
    }, delayMs);
  };
  scheduleNext(initialDelayMs);

  return {
    checkNow,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (timer !== undefined) {
        cancel(timer);
        timer = undefined;
      }
    },
  };
}
