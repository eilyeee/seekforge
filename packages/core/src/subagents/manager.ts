import type { ToolResult } from "@seekforge/shared";
import { onAbortOnce } from "../util/abort.js";

/**
 * Per-session manager for dispatched subagent runs (mirrors the
 * tools/background.ts manager pattern). Every dispatch — foreground or
 * background — registers here so the model can poll it (agent_result) and
 * continue it after completion (agent_send). Each run gets its own
 * AbortController, chained to the parent run's signal; disposeAll() aborts
 * everything still running when the session ends.
 */

export const MAX_STEER_MESSAGE_LENGTH = 4_000;
export const MAX_STEER_QUEUE_LENGTH = 16;

export type DispatchStatus = "running" | "done" | "failed" | "cancelled";

export type DispatchSnapshot = {
  /** Dispatch id, "ag-1", "ag-2", … in start order. */
  id: string;
  agentId: string;
  /** Most recent task sent to the agent. */
  task: string;
  status: DispatchStatus;
  startedAt: string;
  /** Tool names the nested run executed so far (append-only across resumes). */
  steps: string[];
  /** Nested session id; enables agent_send continuation. */
  subSessionId?: string;
  /** Final dispatch-shaped tool result, set once status leaves "running". */
  result?: ToolResult;
  /** Human-readable reason when the dispatch was cancelled. */
  cancelReason?: string;
};

export type DispatchHooks = {
  onStep(toolName: string): void;
  onSubSession(sessionId: string): void;
  /** Drains queued steering messages at a model-turn boundary. */
  takeSteering(): string[];
};

/** Executes one nested subagent run; resolves with the dispatch tool result. */
export type DispatchRunner = (signal: AbortSignal, hooks: DispatchHooks) => Promise<ToolResult>;

export type StartDispatchInput = {
  agentId: string;
  task: string;
  /** Parent cancellation; chained into the dispatch's own AbortController. */
  signal?: AbortSignal;
  run: DispatchRunner;
};

export type DispatchManager = {
  start(input: StartDispatchInput): { id: string; promise: Promise<ToolResult> };
  /**
   * Continue a dispatch that is not running (agent_send). Throws for unknown
   * ids and still-running dispatches — callers must check the snapshot first.
   */
  resume(input: { id: string; task: string; signal?: AbortSignal; run: DispatchRunner }): Promise<ToolResult>;
  get(id: string): DispatchSnapshot | undefined;
  list(): DispatchSnapshot[];
  cancel(id: string): DispatchControlResult;
  steer(id: string, message: string): DispatchControlResult;
  /** Abort every still-running dispatch. Called when the session ends. */
  disposeAll(): void;
};

export type DispatchControlError =
  | "unknown_dispatch"
  | "dispatch_not_running"
  | "invalid_steering"
  | "steering_queue_full";

export type DispatchControlResult = { ok: true } | { ok: false; code: DispatchControlError; message: string };

type DispatchRecord = {
  id: string;
  agentId: string;
  task: string;
  status: DispatchStatus;
  startedAt: string;
  steps: string[];
  subSessionId?: string;
  result?: ToolResult;
  controller?: AbortController;
  steering: string[];
  cancelReason?: string;
};

function snapshot(rec: DispatchRecord): DispatchSnapshot {
  return {
    id: rec.id,
    agentId: rec.agentId,
    task: rec.task,
    status: rec.status,
    startedAt: rec.startedAt,
    steps: [...rec.steps],
    ...(rec.subSessionId !== undefined ? { subSessionId: rec.subSessionId } : {}),
    ...(rec.result !== undefined ? { result: rec.result } : {}),
    ...(rec.cancelReason !== undefined ? { cancelReason: rec.cancelReason } : {}),
  };
}

export function createDispatchManager(): DispatchManager {
  const records = new Map<string, DispatchRecord>();
  let nextId = 0;

  function cancelRecord(rec: DispatchRecord, reason: string): void {
    if (rec.status !== "running") return;
    rec.status = "cancelled";
    rec.cancelReason = reason;
    rec.steering.length = 0;
    rec.controller?.abort();
  }

  function execute(
    rec: DispatchRecord,
    parentSignal: AbortSignal | undefined,
    run: DispatchRunner,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    rec.controller = controller;
    rec.status = "running";
    delete rec.result;
    delete rec.cancelReason;
    rec.steering.length = 0;
    // Bridge parent abort → this dispatch's controller. The listener sits on the
    // long-lived parentSignal, so it must be removed once this dispatch settles;
    // { once: true } only fires-and-removes on abort, leaking one listener per
    // dispatch across a session otherwise.
    const unbindParent = onAbortOnce(parentSignal, () => cancelRecord(rec, "parent run cancelled"));
    const hooks: DispatchHooks = {
      onStep: (toolName) => rec.steps.push(toolName),
      onSubSession: (sessionId) => {
        rec.subSessionId = sessionId;
      },
      takeSteering: () => rec.steering.splice(0),
    };
    return Promise.resolve()
      .then(() => run(controller.signal, hooks))
      .then(
        (result) => {
          unbindParent();
          rec.controller = undefined;
          rec.steering.length = 0;
          if (rec.status === "cancelled" || controller.signal.aborted) {
            const cancelled: ToolResult = {
              ok: false,
              error: { code: "subagent_cancelled", message: rec.cancelReason ?? "dispatch cancelled" },
            };
            rec.status = "cancelled";
            rec.result = cancelled;
            return cancelled;
          }
          rec.status = result.ok ? "done" : "failed";
          rec.result = result;
          return result;
        },
        (err: unknown): ToolResult => {
          unbindParent();
          rec.controller = undefined;
          rec.steering.length = 0;
          if (rec.status === "cancelled" || controller.signal.aborted) {
            const cancelled: ToolResult = {
              ok: false,
              error: { code: "subagent_cancelled", message: rec.cancelReason ?? "dispatch cancelled" },
            };
            rec.status = "cancelled";
            rec.result = cancelled;
            return cancelled;
          }
          const result: ToolResult = {
            ok: false,
            error: { code: "subagent_failed", message: err instanceof Error ? err.message : String(err) },
          };
          rec.status = "failed";
          rec.result = result;
          return result;
        },
      );
  }

  return {
    start({ agentId, task, signal, run }) {
      const id = `ag-${++nextId}`;
      const rec: DispatchRecord = {
        id,
        agentId,
        task,
        status: "running",
        startedAt: new Date().toISOString(),
        steps: [],
        steering: [],
      };
      records.set(id, rec);
      return { id, promise: execute(rec, signal, run) };
    },

    resume({ id, task, signal, run }) {
      const rec = records.get(id);
      if (!rec) throw new Error(`unknown dispatch "${id}"`);
      if (rec.status === "running") throw new Error(`dispatch "${id}" is still running`);
      rec.task = task;
      return execute(rec, signal, run);
    },

    get(id) {
      const rec = records.get(id);
      return rec && snapshot(rec);
    },

    list() {
      return [...records.values()].map(snapshot);
    },

    cancel(id) {
      const rec = records.get(id);
      if (!rec) {
        return { ok: false, code: "unknown_dispatch", message: `unknown dispatch "${id}"` };
      }
      if (rec.status !== "running") {
        return { ok: false, code: "dispatch_not_running", message: `dispatch "${id}" is not running` };
      }
      cancelRecord(rec, "cancelled by user");
      return { ok: true };
    },

    steer(id, message) {
      const rec = records.get(id);
      if (!rec) {
        return { ok: false, code: "unknown_dispatch", message: `unknown dispatch "${id}"` };
      }
      if (rec.status !== "running") {
        return { ok: false, code: "dispatch_not_running", message: `dispatch "${id}" is not running` };
      }
      const steering = message.trim();
      if (steering.length === 0 || steering.length > MAX_STEER_MESSAGE_LENGTH) {
        return {
          ok: false,
          code: "invalid_steering",
          message: `steering must contain 1-${MAX_STEER_MESSAGE_LENGTH} characters`,
        };
      }
      if (rec.steering.length >= MAX_STEER_QUEUE_LENGTH) {
        return { ok: false, code: "steering_queue_full", message: `dispatch "${id}" steering queue is full` };
      }
      rec.steering.push(steering);
      return { ok: true };
    },

    disposeAll() {
      for (const rec of records.values()) {
        cancelRecord(rec, "parent run ended");
      }
    },
  };
}
