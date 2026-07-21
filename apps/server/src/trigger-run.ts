/**
 * Headless, cost-bounded run for a webhook trigger.
 *
 * Reuses the server's existing agent factory (createAgent → buildAgentDeps),
 * exactly like a WS-driven run, but with NO human in the loop:
 *   - the permission callback auto-DENIES anything that would prompt, and the
 *     run uses approvalMode "acceptEdits" so in-workspace edits still apply
 *     while command execution, env changes and dangerous calls (which are never
 *     auto-allowed) are refused — a triggered run can never hang on a prompt;
 *   - ask_user questions are auto-declined for the same reason;
 *   - cumulative spend is watched and the run is aborted the moment it reaches
 *     the trigger's maxCostUsd (the same budget guard the auto-loop uses).
 *
 * The produced session is a normal, auditable JSONL trace. This resolves as
 * soon as the run's session id is known (session.created) so the webhook can
 * answer 202 immediately; the run then continues to completion in the
 * background.
 */

import type { CreateAgentFn } from "./agent.js";
import type { TriggerMode } from "./triggers.js";
import type { RunManager, RunStatus } from "./run-ledger.js";

/** Answer given for a headless ask_user (no interactive user to answer). */
export const HEADLESS_DECLINE = "(no interactive user: this is a headless triggered run)";

/**
 * Default hard token ceiling for a headless triggered run. The cost cap is the
 * primary control, but it is a no-op on providers with no price table (costUsd
 * never grows), so this bounds a run by tokens regardless of pricing. Generous
 * enough not to cut off a legitimately long run; low enough to stop a runaway.
 */
export const DEFAULT_MAX_TRIGGER_TOTAL_TOKENS = 8_000_000;

export type StartTriggerRunInput = {
  createAgent: CreateAgentFn;
  workspace: string;
  task: string;
  mode: TriggerMode;
  /** Hard cap on cumulative spend (USD); the run aborts on reaching it. */
  maxCostUsd: number;
  /**
   * Hard cap on cumulative tokens (prompt + completion). Independent of cost so
   * a provider with no price table (costUsd stays 0) is still bounded. Defaults
   * to DEFAULT_MAX_TRIGGER_TOTAL_TOKENS.
   */
  maxTotalTokens?: number;
  runManager?: RunManager;
  runId?: string;
  /** Optional workspace mutation scheduler shared with other server surfaces. */
  schedule?: (operation: () => Promise<void>, signal: AbortSignal) => Promise<void>;
};

export type TriggerRunHandle = {
  started: Promise<{ sessionId: string }>;
  completion: Promise<void>;
  abort(): void;
};

/**
 * Starts the headless run and resolves with the new session id once it is
 * known. The run keeps going in the background after this resolves; a failure
 * *before* the session id is known rejects (so the webhook can answer 500).
 */
export function startManagedTriggerRun(input: StartTriggerRunInput): TriggerRunHandle {
  const controller = new AbortController();
  const maxTotalTokens = input.maxTotalTokens ?? DEFAULT_MAX_TRIGGER_TOTAL_TOKENS;
  if (input.runManager && input.runId) input.runManager.start(input.runId, input.workspace, controller);
  let resolveStarted!: (value: { sessionId: string }) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<{ sessionId: string }>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let settled = false;
  const execute = async (): Promise<void> => {
    let handle: Awaited<ReturnType<CreateAgentFn>> | undefined;
    let terminalStatus: RunStatus | undefined;
    let sessionId = "";
    try {
      controller.signal.throwIfAborted();
      handle = await input.createAgent({
        workspace: input.workspace,
        // Headless: auto-deny every confirmation. Combined with approvalMode
        // "acceptEdits", in-workspace edits still apply autonomously, but
        // commands, env changes and dangerous calls are refused.
        confirm: async () => false,
        askUser: async () => HEADLESS_DECLINE,
        extractMemory: input.mode === "edit",
        signal: controller.signal,
      });
      const task = handle.expandTask ? await handle.expandTask(input.task, controller.signal) : input.task;
      for await (const event of handle.agent.runTask({
        projectPath: input.workspace,
        task,
        mode: input.mode,
        approvalMode: "acceptEdits",
        signal: controller.signal,
      })) {
        if (event.type === "session.created") sessionId = event.sessionId;
        if (input.runManager && input.runId) {
          input.runManager.appendFrame(input.workspace, input.runId, {
            type: "event",
            sessionId,
            event,
          });
        }
        if (event.type === "session.created") {
          input.runManager?.update(input.workspace, input.runId ?? "", { sessionId: event.sessionId });
          if (!settled) {
            settled = true;
            resolveStarted({ sessionId: event.sessionId });
          }
        } else if (event.type === "usage.updated") {
          input.runManager?.update(input.workspace, input.runId ?? "", { costUsd: event.usage.costUsd });
          // Cumulative guards — SOFT, reactive caps: we abort on the first usage
          // event at/over a ceiling, so the in-flight model turn that crossed it
          // can overshoot by one call. The token ceiling is independent of cost
          // so a provider with no price table (costUsd stays 0) is still bounded.
          const totalTokens = event.usage.promptTokens + event.usage.completionTokens;
          if (event.usage.costUsd >= input.maxCostUsd || totalTokens >= maxTotalTokens) controller.abort();
        } else if (event.type === "session.completed") {
          terminalStatus = "succeeded";
          input.runManager?.update(input.workspace, input.runId ?? "", {
            status: terminalStatus,
            costUsd: event.report.usage.costUsd,
          });
          if (event.report.usage.costUsd >= input.maxCostUsd) controller.abort();
        } else if (event.type === "session.failed") {
          terminalStatus = event.error.code === "cancelled" ? "cancelled" : "failed";
          input.runManager?.update(input.workspace, input.runId ?? "", {
            status: terminalStatus,
            error: { code: event.error.code, message: event.error.message },
          });
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      terminalStatus = controller.signal.aborted ? "cancelled" : "failed";
      input.runManager?.update(input.workspace, input.runId ?? "", {
        status: terminalStatus,
        error: { code: terminalStatus === "cancelled" ? "cancelled" : "trigger_error", message },
      });
      if (input.runManager && input.runId) {
        input.runManager.appendFrame(
          input.workspace,
          input.runId,
          { type: "error", code: terminalStatus === "cancelled" ? "cancelled" : "agent_error", message },
          { cacheSequence: false },
        );
      }
      // A failure after we've already resolved (i.e. mid-background-run) is
      // recorded in the session trace as session.failed; swallow it here so
      // it doesn't surface as an unhandled rejection.
      if (!settled) {
        settled = true;
        rejectStarted(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      try {
        handle?.dispose();
      } catch {
        // Runtime disposal must not reject detached completion or hide state cleanup.
      } finally {
        if (!settled) {
          settled = true;
          rejectStarted(new Error("triggered run produced no session"));
        }
        if (terminalStatus === undefined) {
          input.runManager?.update(input.workspace, input.runId ?? "", {
            status: controller.signal.aborted ? "cancelled" : "failed",
            error: { code: "incomplete", message: "triggered run ended without a terminal event" },
          });
        }
      }
    }
  };
  const scheduled = Promise.resolve().then(() =>
    input.schedule ? input.schedule(execute, controller.signal) : execute(),
  );
  const completion = scheduled.catch((error: unknown) => {
    const cancelled = controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    input.runManager?.update(input.workspace, input.runId ?? "", {
      status: cancelled ? "cancelled" : "failed",
      error: {
        code: cancelled ? "cancelled" : "trigger_schedule_error",
        message,
      },
    });
    if (input.runManager && input.runId) {
      input.runManager.appendFrame(
        input.workspace,
        input.runId,
        { type: "error", code: cancelled ? "cancelled" : "agent_error", message },
        { cacheSequence: false },
      );
    }
    if (!settled) {
      settled = true;
      rejectStarted(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return { started, completion, abort: () => controller.abort() };
}

export function startTriggerRun(input: StartTriggerRunInput): Promise<{ sessionId: string }> {
  return startManagedTriggerRun(input).started;
}
