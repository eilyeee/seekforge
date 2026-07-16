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

export type StartTriggerRunInput = {
  createAgent: CreateAgentFn;
  workspace: string;
  task: string;
  mode: TriggerMode;
  /** Hard cap on cumulative spend (USD); the run aborts on reaching it. */
  maxCostUsd: number;
  runManager?: RunManager;
  runId?: string;
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
  if (input.runManager && input.runId) input.runManager.start(input.runId, input.workspace, controller);
  let resolveStarted!: (value: { sessionId: string }) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<{ sessionId: string }>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });
  let settled = false;
  const completion = (async () => {
    let handle: Awaited<ReturnType<CreateAgentFn>> | undefined;
    let terminalStatus: RunStatus | undefined;
    let sessionId = "";
    try {
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
          // Cumulative spend guard — a SOFT, reactive cap: we abort on the
          // first usage event at/over budget, so the in-flight model turn that
          // crossed it can overshoot by one call. Bound turns/tokens too if a
          // hard ceiling is ever required.
          if (event.usage.costUsd >= input.maxCostUsd) controller.abort();
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
  })();
  return { started, completion, abort: () => controller.abort() };
}

export function startTriggerRun(input: StartTriggerRunInput): Promise<{ sessionId: string }> {
  return startManagedTriggerRun(input).started;
}
