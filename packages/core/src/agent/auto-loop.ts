/**
 * Auto-loop (loop engineering): drives ONE task to "green" across multiple agent
 * runs — run → verify → continue — fully autonomously, stopping when a
 * verification command passes or a budget guardrail trips. This wraps `runTask`
 * (one run per iteration, resuming the same session so the whole loop is one
 * auditable trace); it is distinct from the in-run tool loop in loop.ts.
 *
 * NOTE: the public types + signature below are the contract the CLI builds
 * against; the implementation is filled in separately.
 */
import type { ApprovalMode } from "@seekforge/shared";
import { ToolError } from "../tools/errors.js";
import { runShellCommand } from "../tools/run-command.js";
import { createAgentCore, type AgentCoreDeps } from "./loop.js";

export type LoopStatus =
  | "passed" // verification command exited 0
  | "exhausted" // hit maxIterations
  | "no_progress" // stuck: identical verify output + no file changes
  | "budget" // hit costBudgetUsd
  | "cancelled" // aborted via signal
  | "verify_error"; // the verify command could not be run at all

export type LoopOptions = {
  /** The goal handed to the agent on the first iteration. */
  task: string;
  /** Absolute workspace path. */
  workspace: string;
  /** Shell command whose exit 0 means "done" (the success criterion). */
  verifyCommand: string;
  /** Max run iterations before giving up. Default 8. */
  maxIterations?: number;
  /** Hard cap on cumulative cost (USD) across iterations. */
  costBudgetUsd?: number;
  /** Approval mode for each run; default "acceptEdits" (autonomous edits). */
  approvalMode?: ApprovalMode;
  model?: string;
  planModel?: string;
  /** Hand failing runs to planModel (mirrors AgentCoreDeps.escalateOnFailure). */
  escalateOnFailure?: boolean;
  /** Cooperative stop (Ctrl-C / a Stop button). */
  signal?: AbortSignal;
  /** Per-iteration progress callback. */
  onEvent?: (event: LoopEvent) => void;
  /**
   * Runs the verification command and returns its exit code + captured output
   * (stdout+stderr, tail-capped). Defaults to a real shell exec in `workspace`;
   * injectable for tests.
   */
  verify?: (workspace: string, command: string, signal?: AbortSignal) => Promise<{ code: number; output: string }>;
};

export type LoopEvent =
  | { type: "iteration.start"; iteration: number }
  | { type: "run.completed"; iteration: number; costUsd: number }
  | { type: "verify"; iteration: number; code: number; passed: boolean; output: string }
  | { type: "loop.done"; result: LoopResult };

export type LoopResult = {
  status: LoopStatus;
  iterations: number;
  costUsd: number;
  sessionId: string;
  finalVerify: { code: number; output: string };
};

/** Tail-cap captured output to ~4 KB so continuations/results stay bounded. */
const TAIL_CAP = 4096;
const tail = (s: string): string => (s.length <= TAIL_CAP ? s : s.slice(s.length - TAIL_CAP));

/**
 * Default verify runner: a real shell exec in `workspace`. Resolves with the
 * exit code (0 on success; non-zero or a spawn failure otherwise) and the
 * tail-capped stdout+stderr. A spawn failure (command can't be run at all) is
 * surfaced as a thrown error so the pre-check can map it to `verify_error`.
 */
async function defaultVerify(
  deps: AgentCoreDeps,
  workspace: string,
  command: string,
  signal?: AbortSignal,
): Promise<{ code: number; output: string }> {
  try {
    const result = await runShellCommand(command, workspace, 120_000, {
      sandbox: deps.sandbox,
      workspace,
      signal,
    });
    return { code: result.exitCode, output: tail(`${result.stdout}${result.stderr}`) };
  } catch (err) {
    if (err instanceof ToolError && err.code === "timeout") {
      const detail = err.detail as { stdout?: string; stderr?: string } | undefined;
      return { code: 1, output: tail(`${detail?.stdout ?? ""}${detail?.stderr ?? ""}`) || err.message };
    }
    throw err;
  }
}

export async function runAutoLoop(deps: AgentCoreDeps, opts: LoopOptions): Promise<LoopResult> {
  const emit = (event: LoopEvent): void => opts.onEvent?.(event);
  const verify = opts.verify ?? ((workspace, command, signal) => defaultVerify(deps, workspace, command, signal));
  // Defensive: ignore non-positive / non-integer / non-finite limits (the WS
  // entry validates too, but core may be called directly).
  const maxIterations =
    Number.isInteger(opts.maxIterations) && (opts.maxIterations as number) > 0
      ? (opts.maxIterations as number)
      : 8;
  const costBudgetUsd =
    typeof opts.costBudgetUsd === "number" && Number.isFinite(opts.costBudgetUsd) && opts.costBudgetUsd > 0
      ? opts.costBudgetUsd
      : undefined;
  const approvalMode: ApprovalMode = opts.approvalMode ?? "acceptEdits";

  const agent = createAgentCore({
    ...deps,
    ...(opts.escalateOnFailure !== undefined ? { escalateOnFailure: opts.escalateOnFailure } : {}),
    ...(opts.planModel ? { planModel: opts.planModel } : {}),
  });

  const done = (result: LoopResult): LoopResult => {
    emit({ type: "loop.done", result });
    return result;
  };

  // --- Pre-check: maybe it's already green. ---------------------------------
  let preVerify: { code: number; output: string };
  if (opts.signal?.aborted) {
    return done({
      status: "cancelled",
      iterations: 0,
      costUsd: 0,
      sessionId: "",
      finalVerify: { code: -1, output: "cancelled" },
    });
  }
  try {
    preVerify = await verify(opts.workspace, opts.verifyCommand, opts.signal);
  } catch {
    if (opts.signal?.aborted) {
      return done({
        status: "cancelled",
        iterations: 0,
        costUsd: 0,
        sessionId: "",
        finalVerify: { code: -1, output: "cancelled" },
      });
    }
    // The command could not be run at all.
    const result: LoopResult = {
      status: "verify_error",
      iterations: 0,
      costUsd: 0,
      sessionId: "",
      finalVerify: { code: -1, output: "verify command could not be run" },
    };
    return done(result);
  }
  if (preVerify.code === 0) {
    const result: LoopResult = {
      status: "passed",
      iterations: 0,
      costUsd: 0,
      sessionId: "",
      finalVerify: preVerify,
    };
    return done(result);
  }

  // --- Iterate run → verify → continue. ------------------------------------
  let sessionId = "";
  let costUsd = 0;
  let lastVerify = preVerify;
  let prevOutput: string | null = null;
  let iterations = 0;

  for (let i = 1; i <= maxIterations; i++) {
    if (opts.signal?.aborted) {
      return done({ status: "cancelled", iterations, costUsd, sessionId, finalVerify: lastVerify });
    }
    if (costBudgetUsd !== undefined && costUsd >= costBudgetUsd) {
      return done({ status: "budget", iterations, costUsd, sessionId, finalVerify: lastVerify });
    }
    iterations = i;
    emit({ type: "iteration.start", iteration: i });

    const continuation =
      i === 1
        ? opts.task
        : `\`${opts.verifyCommand}\` still fails:\n\n${lastVerify.output}\n\nFix the root cause so it passes.`;

    let runCost = 0;
    let filesChangedThisRun = false;
    const budgetController = new AbortController();
    const runSignal = opts.signal
      ? AbortSignal.any([opts.signal, budgetController.signal])
      : budgetController.signal;
    const events = agent.runTask({
      task: continuation,
      projectPath: opts.workspace,
      mode: "edit",
      approvalMode,
      signal: runSignal,
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
    });
    for await (const ev of events) {
      if (ev.type === "session.created") {
        if (!sessionId) sessionId = ev.sessionId;
      } else if (ev.type === "file.changed") {
        filesChangedThisRun = true;
      } else if (ev.type === "usage.updated") {
        // Cumulative spend within this run. Tracked here so a failed run — which
        // emits no FinalReport — still contributes its real cost to the budget
        // guard below; otherwise repeated expensive failures overshoot silently.
        runCost = ev.usage.costUsd;
        if (costBudgetUsd !== undefined && costUsd + runCost >= costBudgetUsd) {
          budgetController.abort();
        }
      } else if (ev.type === "session.completed") {
        runCost = ev.report.usage.costUsd;
      }
    }
    costUsd += runCost;
    emit({ type: "run.completed", iteration: i, costUsd });

    // Verify the run's effect.
    let v: { code: number; output: string };
    try {
      v = await verify(opts.workspace, opts.verifyCommand, opts.signal);
    } catch {
      if (opts.signal?.aborted) {
        return done({
          status: "cancelled",
          iterations: i,
          costUsd,
          sessionId,
          finalVerify: { code: -1, output: "cancelled" },
        });
      }
      const result: LoopResult = {
        status: "verify_error",
        iterations: i,
        costUsd,
        sessionId,
        finalVerify: { code: -1, output: "verify command could not be run" },
      };
      return done(result);
    }
    lastVerify = v;
    emit({ type: "verify", iteration: i, code: v.code, passed: v.code === 0, output: v.output });

    if (v.code === 0) {
      return done({ status: "passed", iterations: i, costUsd, sessionId, finalVerify: v });
    }

    // --- Guardrails (checked before spending another iteration). -----------
    if (opts.signal?.aborted) {
      return done({ status: "cancelled", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    if (costBudgetUsd !== undefined && costUsd >= costBudgetUsd) {
      return done({ status: "budget", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    // Stuck only when the verify output is byte-identical AND this run changed
    // no files — repeated edits that haven't yet moved the error message are
    // still progress (per the LoopStatus contract), so don't abort on them.
    if (prevOutput !== null && v.output === prevOutput && !filesChangedThisRun) {
      return done({ status: "no_progress", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    prevOutput = v.output;
  }

  return done({ status: "exhausted", iterations, costUsd, sessionId, finalVerify: lastVerify });
}
