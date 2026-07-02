import type { ToolResult } from "@seekforge/shared";

/**
 * Per-session manager for dispatched subagent runs (mirrors the
 * tools/background.ts manager pattern). Every dispatch — foreground or
 * background — registers here so the model can poll it (agent_result) and
 * continue it after completion (agent_send). Each run gets its own
 * AbortController, chained to the parent run's signal; disposeAll() aborts
 * everything still running when the session ends.
 */

export type DispatchStatus = "running" | "done" | "failed";

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
};

export type DispatchHooks = {
  onStep(toolName: string): void;
  onSubSession(sessionId: string): void;
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
  /** Abort every still-running dispatch. Called when the session ends. */
  disposeAll(): void;
};

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
  };
}

export function createDispatchManager(): DispatchManager {
  const records = new Map<string, DispatchRecord>();
  let nextId = 0;

  function execute(rec: DispatchRecord, parentSignal: AbortSignal | undefined, run: DispatchRunner): Promise<ToolResult> {
    const controller = new AbortController();
    // Bridge parent abort → this dispatch's controller. The listener sits on the
    // long-lived parentSignal, so it must be removed once this dispatch settles;
    // { once: true } only fires-and-removes on abort, leaking one listener per
    // dispatch across a session otherwise.
    let unbindParent: (() => void) | undefined;
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort();
      else {
        const onAbort = (): void => controller.abort();
        parentSignal.addEventListener("abort", onAbort, { once: true });
        unbindParent = () => parentSignal.removeEventListener("abort", onAbort);
      }
    }
    rec.controller = controller;
    rec.status = "running";
    delete rec.result;
    const hooks: DispatchHooks = {
      onStep: (toolName) => rec.steps.push(toolName),
      onSubSession: (sessionId) => {
        rec.subSessionId = sessionId;
      },
    };
    return Promise.resolve()
      .then(() => run(controller.signal, hooks))
      .then(
        (result) => {
          unbindParent?.();
          rec.status = result.ok ? "done" : "failed";
          rec.result = result;
          return result;
        },
        (err: unknown): ToolResult => {
          unbindParent?.();
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

    disposeAll() {
      for (const rec of records.values()) {
        if (rec.status === "running") rec.controller?.abort();
      }
    },
  };
}
