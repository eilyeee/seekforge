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
import { execFile } from "node:child_process";
import type { ApprovalMode } from "@seekforge/shared";
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
  verify?: (workspace: string, command: string) => Promise<{ code: number; output: string }>;
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
function defaultVerify(workspace: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd: workspace,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        const output = tail(`${stdout ?? ""}${stderr ?? ""}`);
        if (err === null) {
          resolve({ code: 0, output });
          return;
        }
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        // execFile reports a non-zero EXIT via `err.code` being a number; a
        // genuine SPAWN failure (e.g. /bin/sh missing) surfaces a string code
        // (ENOENT, …) — that's "can't run the command at all".
        if (typeof e.code === "number") {
          resolve({ code: e.code, output });
          return;
        }
        if (e.killed) {
          // Timed out / killed: ran, but didn't pass.
          resolve({ code: 1, output: output || String(e.message ?? "killed") });
          return;
        }
        reject(err);
      },
    );
  });
}

export async function runAutoLoop(deps: AgentCoreDeps, opts: LoopOptions): Promise<LoopResult> {
  const emit = (event: LoopEvent): void => opts.onEvent?.(event);
  const verify = opts.verify ?? defaultVerify;
  const maxIterations = opts.maxIterations ?? 8;
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
  try {
    preVerify = await verify(opts.workspace, opts.verifyCommand);
  } catch {
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
    iterations = i;
    emit({ type: "iteration.start", iteration: i });

    const continuation =
      i === 1
        ? opts.task
        : `\`${opts.verifyCommand}\` still fails:\n\n${lastVerify.output}\n\nFix the root cause so it passes.`;

    let runCost = 0;
    const events = agent.runTask({
      task: continuation,
      projectPath: opts.workspace,
      mode: "edit",
      approvalMode,
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(sessionId ? { resumeSessionId: sessionId } : {}),
    });
    for await (const ev of events) {
      if (ev.type === "session.created") {
        if (!sessionId) sessionId = ev.sessionId;
      } else if (ev.type === "session.completed") {
        runCost += ev.report.usage.costUsd;
      } else if (ev.type === "session.failed") {
        // A failed run still consumed budget if it reported any; failures carry
        // no FinalReport, so there is nothing to add — counted by being a run.
      }
    }
    costUsd += runCost;
    emit({ type: "run.completed", iteration: i, costUsd });

    // Verify the run's effect.
    let v: { code: number; output: string };
    try {
      v = await verify(opts.workspace, opts.verifyCommand);
    } catch {
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
    if (opts.costBudgetUsd !== undefined && costUsd >= opts.costBudgetUsd) {
      return done({ status: "budget", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    if (prevOutput !== null && v.output === prevOutput) {
      return done({ status: "no_progress", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    prevOutput = v.output;
  }

  return done({ status: "exhausted", iterations, costUsd, sessionId, finalVerify: lastVerify });
}
