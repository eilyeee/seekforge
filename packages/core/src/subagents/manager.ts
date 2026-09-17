import { addUsage, type TokenUsage, type ToolResult } from "@seekforge/shared";
import { onAbortOnce } from "../util/abort.js";

/**
 * Manager for dispatched subagent runs (mirrors the tools/background.ts
 * manager pattern). Every dispatch — foreground or background — registers here
 * so the model can poll it (agent_result) and continue it after completion
 * (agent_send). Each run gets its own AbortController, chained to the parent
 * run's signal.
 *
 * Two lifetimes:
 * - run-scoped (default): the agent loop calls disposeAll() when the run that
 *   owns the manager ends, so every dispatch dies with that run.
 * - session-scoped (`createDispatchManager({ sessionScoped: true })`): a host
 *   keeps one manager for a whole interactive session and passes it to every
 *   run. At run end the loop only cancels that run's foreground dispatches;
 *   background dispatches keep running, and their outcome reaches the model at
 *   the start of the next run (takeUndelivered). The HOST calls disposeAll()
 *   when the session ends.
 */

export const MAX_STEER_MESSAGE_LENGTH = 4_000;
export const MAX_STEER_QUEUE_LENGTH = 16;
/** Longest progress message a child may send its parent (longer ones are cut). */
export const MAX_AGENT_REPORT_LENGTH = 500;
/** Progress messages one nested run may send before further ones are refused. */
export const MAX_AGENT_REPORTS_PER_RUN = 20;
/** Undelivered progress messages kept per dispatch; older ones are dropped. */
const MAX_PENDING_REPORTS = 5;
/** Recent progress messages kept per dispatch for agent_result. */
const MAX_RECENT_REPORTS = 10;

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
  /** Started with background:true (its latest execution). */
  background: boolean;
  /** Progress messages the child sent (most recent last, bounded). */
  reports: string[];
};

export type DispatchHooks = {
  onStep(toolName: string): void;
  onSubSession(sessionId: string): void;
  /** Drains queued steering messages at a model-turn boundary. */
  takeSteering(): string[];
  /** Records a child → parent progress message; refuses past the per-run bound. */
  report(message: string): DispatchControlResult;
};

/** Executes one nested subagent run; resolves with the dispatch tool result. */
export type DispatchRunner = (signal: AbortSignal, hooks: DispatchHooks) => Promise<ToolResult>;

export type StartDispatchInput = {
  agentId: string;
  task: string;
  /** Parent cancellation; chained into the dispatch's own AbortController. */
  signal?: AbortSignal;
  /** The caller returns before this dispatch settles (dispatch_agent background:true). */
  background?: boolean;
  run: DispatchRunner;
};

export type AgentReport = { dispatchId: string; agentId: string; message: string };

export type DispatchManager = {
  /** True for a host-owned manager that outlives individual runs. */
  readonly sessionScoped: boolean;
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
  /** Abort every still-running dispatch. Called when the owner (run or session) ends. */
  disposeAll(): void;
  /**
   * A run is starting on this manager; returns its generation. Dispatches
   * started from now on belong to it.
   */
  beginRun(): number;
  /**
   * The run of `generation` is ending: cancel its running foreground
   * dispatches. Background dispatches keep running on a session-scoped
   * manager and are cancelled on a run-scoped one.
   */
  endRun(generation: number, reason: string): void;
  /**
   * Terminal background dispatches started by an EARLIER run whose outcome
   * has not reached the model; they are marked delivered.
   */
  takeUndelivered(generation: number): DispatchSnapshot[];
  /** The model has seen this dispatch's terminal outcome (agent_result). */
  markDelivered(id: string): void;
  /** Whether this dispatch's current terminal event was already emitted to a live run. */
  terminalEmitted(id: string): boolean;
  markTerminalEmitted(id: string): void;
  /** Undelivered progress messages of still-running dispatches; drained. */
  takeReports(): AgentReport[];
  /** Usage a dispatch spent after its run ended, for the next run to account. */
  addDetachedUsage(usage: TokenUsage): void;
  takeDetachedUsage(): TokenUsage | undefined;
};

export type DispatchControlError =
  | "unknown_dispatch"
  | "dispatch_not_running"
  | "invalid_steering"
  | "steering_queue_full"
  | "invalid_report"
  | "report_limit";

export type DispatchControlResult = { ok: true } | { ok: false; code: DispatchControlError; message: string };

export type DispatchManagerOptions = {
  /** Keep background dispatches alive across runs (see the module comment). */
  sessionScoped?: boolean;
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
  steering: string[];
  cancelReason?: string;
  background: boolean;
  generation: number;
  delivered: boolean;
  terminalEmitted: boolean;
  reports: string[];
  pendingReports: string[];
  reportsThisRun: number;
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
    background: rec.background,
    reports: [...rec.reports],
  };
}

export function createDispatchManager(options: DispatchManagerOptions = {}): DispatchManager {
  const records = new Map<string, DispatchRecord>();
  const sessionScoped = options.sessionScoped === true;
  let nextId = 0;
  let generation = 0;
  let detachedUsage: TokenUsage | undefined;

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
    rec.delivered = false;
    rec.terminalEmitted = false;
    rec.pendingReports.length = 0;
    rec.reportsThisRun = 0;
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
      report: (raw) => {
        if (rec.status !== "running" || rec.controller !== controller) {
          return { ok: false, code: "dispatch_not_running", message: `dispatch "${rec.id}" is not running` };
        }
        const message = raw.replace(/\s+/g, " ").trim();
        if (message === "") return { ok: false, code: "invalid_report", message: "report must not be empty" };
        if (rec.reportsThisRun >= MAX_AGENT_REPORTS_PER_RUN) {
          return {
            ok: false,
            code: "report_limit",
            message: `report limit reached (${MAX_AGENT_REPORTS_PER_RUN} per run); put the rest in your final report`,
          };
        }
        rec.reportsThisRun++;
        const bounded =
          message.length > MAX_AGENT_REPORT_LENGTH ? `${message.slice(0, MAX_AGENT_REPORT_LENGTH - 1)}…` : message;
        rec.reports.push(bounded);
        if (rec.reports.length > MAX_RECENT_REPORTS) rec.reports.splice(0, rec.reports.length - MAX_RECENT_REPORTS);
        rec.pendingReports.push(bounded);
        if (rec.pendingReports.length > MAX_PENDING_REPORTS) {
          rec.pendingReports.splice(0, rec.pendingReports.length - MAX_PENDING_REPORTS);
        }
        return { ok: true };
      },
    };
    return Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          return {
            ok: false,
            error: { code: "subagent_cancelled", message: rec.cancelReason ?? "dispatch cancelled" },
          } satisfies ToolResult;
        }
        return run(controller.signal, hooks);
      })
      .then(
        (result) => {
          unbindParent();
          rec.controller = undefined;
          rec.steering.length = 0;
          rec.pendingReports.length = 0;
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
          rec.pendingReports.length = 0;
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
    sessionScoped,

    start({ agentId, task, signal, background, run }) {
      const id = `ag-${++nextId}`;
      const rec: DispatchRecord = {
        id,
        agentId,
        task,
        status: "running",
        startedAt: new Date().toISOString(),
        steps: [],
        steering: [],
        background: background === true,
        generation,
        delivered: false,
        terminalEmitted: false,
        reports: [],
        pendingReports: [],
        reportsThisRun: 0,
      };
      records.set(id, rec);
      return { id, promise: execute(rec, signal, run) };
    },

    resume({ id, task, signal, run }) {
      const rec = records.get(id);
      if (!rec) throw new Error(`unknown dispatch "${id}"`);
      if (rec.status === "running" || rec.controller !== undefined) {
        throw new Error(`dispatch "${id}" is still running`);
      }
      rec.task = task;
      rec.background = false;
      rec.generation = generation;
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
        cancelRecord(rec, sessionScoped ? "session ended" : "parent run ended");
      }
    },

    beginRun() {
      return ++generation;
    },

    endRun(runGeneration, reason) {
      for (const rec of records.values()) {
        if (rec.generation !== runGeneration) continue;
        if (sessionScoped && rec.background) continue;
        cancelRecord(rec, reason);
      }
    },

    takeUndelivered(runGeneration) {
      const out: DispatchSnapshot[] = [];
      for (const rec of records.values()) {
        if (!rec.background || rec.delivered || rec.status === "running" || rec.generation >= runGeneration) continue;
        rec.delivered = true;
        out.push(snapshot(rec));
      }
      return out;
    },

    markDelivered(id) {
      const rec = records.get(id);
      if (rec && rec.status !== "running") rec.delivered = true;
    },

    terminalEmitted(id) {
      return records.get(id)?.terminalEmitted === true;
    },

    markTerminalEmitted(id) {
      const rec = records.get(id);
      if (rec && rec.status !== "running") rec.terminalEmitted = true;
    },

    takeReports() {
      const out: AgentReport[] = [];
      for (const rec of records.values()) {
        if (rec.pendingReports.length === 0) continue;
        const messages = rec.pendingReports.splice(0);
        if (rec.status !== "running") continue;
        for (const message of messages) out.push({ dispatchId: rec.id, agentId: rec.agentId, message });
      }
      return out;
    },

    addDetachedUsage(usage) {
      detachedUsage = detachedUsage ? addUsage(detachedUsage, usage) : usage;
    },

    takeDetachedUsage() {
      const usage = detachedUsage;
      detachedUsage = undefined;
      return usage;
    },
  };
}
