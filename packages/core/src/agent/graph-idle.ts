import type { EngineeringGraphState } from "./graph-state.js";
import { createRecurringIdleTimer, idleTimerDelay } from "./idle-scheduler.js";

export const DEFAULT_GRAPH_IDLE_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_GRAPH_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;

export type IdleGraphMaintenanceTarget = {
  workspace: string;
  /** Return undefined when the workspace stopped being idle before work began. */
  maintain: (signal: AbortSignal) => Promise<EngineeringGraphState[] | undefined>;
};

export type IdleGraphMaintenanceResult = {
  workspace: string;
  outcome:
    | { status: "completed"; states: EngineeringGraphState[] }
    | { status: "busy" }
    | { status: "failed"; error: string };
};

export type GraphMaintenanceScheduler = {
  checkNow(): Promise<IdleGraphMaintenanceResult[]>;
  dispose(): void;
};

export function createGraphMaintenanceScheduler(options: {
  targets: () => Iterable<IdleGraphMaintenanceTarget>;
  initialDelayMs?: number;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onResults?: (results: IdleGraphMaintenanceResult[]) => void;
}): GraphMaintenanceScheduler {
  const initialDelayMs = idleTimerDelay(
    options.initialDelayMs,
    DEFAULT_GRAPH_IDLE_INITIAL_DELAY_MS,
    "initialDelayMs",
    true,
  );
  const intervalMs = idleTimerDelay(options.intervalMs, DEFAULT_GRAPH_IDLE_CHECK_INTERVAL_MS, "intervalMs", false);
  const controller = new AbortController();
  let disposed = false;
  let checking = false;
  const checkNow = async (): Promise<IdleGraphMaintenanceResult[]> => {
    if (disposed || checking) return [];
    checking = true;
    try {
      let targets: IdleGraphMaintenanceTarget[];
      try {
        targets = [...options.targets()];
      } catch {
        return [];
      }
      const results: IdleGraphMaintenanceResult[] = [];
      for (const target of targets) {
        if (controller.signal.aborted) break;
        try {
          const states = await target.maintain(controller.signal);
          results.push({
            workspace: target.workspace,
            outcome: states === undefined ? { status: "busy" } : { status: "completed", states },
          });
        } catch (error) {
          if (controller.signal.aborted) break;
          results.push({
            workspace: target.workspace,
            outcome: { status: "failed", error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      if (!disposed) {
        try {
          options.onResults?.(results);
        } catch {
          // Observability is isolated from maintenance and future ticks.
        }
      }
      return results;
    } finally {
      checking = false;
    }
  };
  const timer = createRecurringIdleTimer({
    initialDelayMs,
    intervalMs,
    run: checkNow,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.cancel ? { cancel: options.cancel } : {}),
  });
  return {
    checkNow,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      timer.dispose();
    },
  };
}
