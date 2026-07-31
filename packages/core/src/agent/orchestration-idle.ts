import { createRecurringIdleTimer, idleTimerDelay } from "./idle-scheduler.js";
import type { WorkspaceOrchestrationMaintenanceResult } from "./orchestration-maintenance.js";

export const DEFAULT_ORCHESTRATION_IDLE_INITIAL_DELAY_MS = 30_000;
export const DEFAULT_ORCHESTRATION_IDLE_CHECK_INTERVAL_MS = 5 * 60_000;

export type IdleOrchestrationMaintenanceTarget = {
  workspace: string;
  maintain: (signal: AbortSignal) => Promise<WorkspaceOrchestrationMaintenanceResult | undefined>;
};

export type IdleOrchestrationMaintenanceResult = {
  workspace: string;
  outcome:
    | { status: "completed"; result: WorkspaceOrchestrationMaintenanceResult }
    | { status: "busy" }
    | { status: "failed"; error: string };
};

export type OrchestrationMaintenanceScheduler = {
  checkNow(): Promise<IdleOrchestrationMaintenanceResult[]>;
  dispose(): void;
};

export function createOrchestrationMaintenanceScheduler(options: {
  targets: () => Iterable<IdleOrchestrationMaintenanceTarget>;
  initialDelayMs?: number;
  intervalMs?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onResults?: (results: IdleOrchestrationMaintenanceResult[]) => void;
}): OrchestrationMaintenanceScheduler {
  const initialDelayMs = idleTimerDelay(
    options.initialDelayMs,
    DEFAULT_ORCHESTRATION_IDLE_INITIAL_DELAY_MS,
    "initialDelayMs",
    true,
  );
  const intervalMs = idleTimerDelay(
    options.intervalMs,
    DEFAULT_ORCHESTRATION_IDLE_CHECK_INTERVAL_MS,
    "intervalMs",
    false,
  );
  const controller = new AbortController();
  let disposed = false;
  let checking = false;
  const checkNow = async (): Promise<IdleOrchestrationMaintenanceResult[]> => {
    if (disposed || checking) return [];
    checking = true;
    try {
      let targets: IdleOrchestrationMaintenanceTarget[];
      try {
        targets = [...options.targets()];
      } catch {
        return [];
      }
      const results: IdleOrchestrationMaintenanceResult[] = [];
      for (const target of targets) {
        if (controller.signal.aborted) break;
        try {
          const result = await target.maintain(controller.signal);
          results.push({
            workspace: target.workspace,
            outcome: result ? { status: "completed", result } : { status: "busy" },
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
          // Observability must not stop later idle control ticks.
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
    dispose(): void {
      if (disposed) return;
      disposed = true;
      controller.abort();
      timer.dispose();
    },
  };
}
