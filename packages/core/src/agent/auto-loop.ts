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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../tools/errors.js";
import { runShellCommand } from "../tools/run-command.js";
import {
  createLoopState,
  loadLoopState,
  saveLoopState,
  type LoopState,
} from "./loop-state.js";
import { createAgentCore, type AgentCoreDeps } from "./loop.js";
import { parseVerifyDiagnostics, type VerifyDiagnostics } from "./verify-diagnostics.js";
import { MAX_LOOP_ITERATIONS } from "./loop-constants.js";

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
  /** Stable persisted id; generated when omitted. */
  loopId?: string;
  /** Internal resume state loaded by resumeAutoLoop. */
  resumeState?: LoopState;
  /** Disable `.seekforge/loops` persistence for embedders/tests. Default true. */
  persist?: boolean;
  /**
   * Runs the verification command and returns its exit code + captured output
   * (stdout+stderr, tail-capped). Defaults to a real shell exec in `workspace`;
   * injectable for tests.
   */
  verify?: (
    workspace: string,
    command: string,
    signal?: AbortSignal,
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
  ) => Promise<{ code: number; output: string }>;
};

export type LoopEvent =
  | { type: "iteration.start"; iteration: number }
  | { type: "run.completed"; iteration: number; costUsd: number }
  | { type: "verify.output"; iteration: number; stream: "stdout" | "stderr"; chunk: string }
  | { type: "verify"; iteration: number; code: number; passed: boolean; output: string }
  | { type: "loop.done"; result: LoopResult };

export type LoopResult = {
  status: LoopStatus;
  iterations: number;
  costUsd: number;
  sessionId: string;
  finalVerify: { code: number; output: string };
  /** Stable id of the persisted orchestration state. */
  loopId?: string;
};

/** Tail-cap captured output to ~4 KB so continuations/results stay bounded. */
const TAIL_CAP = 4096;
const tail = (s: string): string => (s.length <= TAIL_CAP ? s : s.slice(s.length - TAIL_CAP));

function workspaceFingerprint(workspace: string): string | null {
  try {
    const hash = createHash("sha256");
    const internalExcludes = [
      ":(exclude).seekforge/loops/**",
      ":(exclude).seekforge/sessions/**",
      ":(exclude).seekforge/uploads/**",
    ];
    hash.update(execFileSync("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--", ".", ...internalExcludes], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }));
    const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\0").filter((path) =>
      Boolean(path) &&
      !path.startsWith(".seekforge/loops/") &&
      !path.startsWith(".seekforge/sessions/") &&
      !path.startsWith(".seekforge/uploads/"),
    ).sort();
    for (const path of untracked) {
      hash.update(`\0${path}\0`);
      try {
        const content = readFileSync(join(workspace, path));
        hash.update(content.subarray(0, 1_000_000));
        hash.update(String(content.length));
      } catch {
        hash.update("<unreadable>");
      }
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function diagnosticPrompt(diagnostics: VerifyDiagnostics, fallback: string): string {
  if (diagnostics.framework === "unknown") return fallback;
  const tests = diagnostics.failedTests.length > 0
    ? `Failed tests:\n${diagnostics.failedTests.map((test) => `- ${test}`).join("\n")}\n\n`
    : "";
  const locations = diagnostics.diagnostics.length > 0
    ? `Diagnostics:\n${diagnostics.diagnostics.map((d) =>
        `- ${d.file ?? "unknown"}${d.line ? `:${d.line}` : ""}: ${d.message}`).join("\n")}\n\n`
    : "";
  return `${tests}${locations}Output tail:\n${fallback}`;
}

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
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<{ code: number; output: string }> {
  try {
    const result = await runShellCommand(command, workspace, 120_000, {
      sandbox: deps.sandbox,
      workspace,
      signal,
      onOutput,
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

const MAX_LIVE_VERIFY_EVENTS = 100;
const MAX_LIVE_VERIFY_CHUNK = 16_384;

function liveVerifyOutput(
  iteration: number,
  emit: (event: LoopEvent) => void,
): (stream: "stdout" | "stderr", chunk: string) => void {
  let emitted = 0;
  return (stream, chunk) => {
    if (emitted >= MAX_LIVE_VERIFY_EVENTS || chunk.length === 0) return;
    emitted += 1;
    emit({
      type: "verify.output",
      iteration,
      stream,
      chunk: chunk.slice(-MAX_LIVE_VERIFY_CHUNK),
    });
  };
}

export async function runAutoLoop(deps: AgentCoreDeps, opts: LoopOptions): Promise<LoopResult> {
  const emit = (event: LoopEvent): void => opts.onEvent?.(event);
  const verify = opts.verify ?? ((workspace, command, signal, onOutput) =>
    defaultVerify(deps, workspace, command, signal, onOutput));
  // Defensive: ignore non-positive / non-integer / non-finite limits (the WS
  // entry validates too, but core may be called directly).
  const requestedIterations =
    Number.isInteger(opts.maxIterations ?? opts.resumeState?.maxIterations) &&
    (opts.maxIterations ?? opts.resumeState?.maxIterations ?? 0) > 0
      ? (opts.maxIterations ?? opts.resumeState?.maxIterations as number)
      : 8;
  const maxIterations = Math.min(requestedIterations, MAX_LOOP_ITERATIONS);
  const costBudgetUsd =
    typeof (opts.costBudgetUsd ?? opts.resumeState?.costBudgetUsd) === "number" &&
    Number.isFinite(opts.costBudgetUsd ?? opts.resumeState?.costBudgetUsd) &&
    (opts.costBudgetUsd ?? opts.resumeState?.costBudgetUsd ?? 0) > 0
      ? (opts.costBudgetUsd ?? opts.resumeState?.costBudgetUsd ?? undefined)
      : undefined;
  const approvalMode: ApprovalMode = opts.approvalMode ?? "acceptEdits";

  const agent = createAgentCore({
    ...deps,
    ...(opts.escalateOnFailure !== undefined ? { escalateOnFailure: opts.escalateOnFailure } : {}),
    ...(opts.planModel ? { planModel: opts.planModel } : {}),
  });

  let state: LoopState | undefined = opts.resumeState;
  if (opts.persist !== false && state === undefined) {
    state = createLoopState({
      loopId: opts.loopId,
      task: opts.task,
      workspace: opts.workspace,
      verifyCommand: opts.verifyCommand,
      maxIterations,
      costBudgetUsd: costBudgetUsd ?? null,
    });
  } else if (state !== undefined) {
    state = { ...state, status: "running", updatedAt: new Date().toISOString() };
    saveLoopState(opts.workspace, state);
  }
  const persist = (patch: Partial<LoopState>): void => {
    if (state === undefined) return;
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    saveLoopState(opts.workspace, state);
  };
  const initialIterations = opts.resumeState?.iterations ?? 0;
  const initialCostUsd = opts.resumeState?.costUsd ?? 0;
  const initialSessionId = opts.resumeState?.sessionId ?? "";

  const done = (result: LoopResult): LoopResult => {
    const withId = state === undefined ? result : { ...result, loopId: state.loopId };
    persist({
      status: withId.status,
      iterations: withId.iterations,
      costUsd: withId.costUsd,
      sessionId: withId.sessionId,
      lastVerify: withId.finalVerify,
    });
    emit({ type: "loop.done", result: withId });
    return withId;
  };

  // --- Pre-check: maybe it's already green. ---------------------------------
  let preVerify: { code: number; output: string };
  if (opts.signal?.aborted) {
    return done({
      status: "cancelled",
      iterations: initialIterations,
      costUsd: initialCostUsd,
      sessionId: initialSessionId,
      finalVerify: { code: -1, output: "cancelled" },
    });
  }
  try {
    preVerify = await verify(
      opts.workspace,
      opts.verifyCommand,
      opts.signal,
      liveVerifyOutput(0, emit),
    );
  } catch {
    if (opts.signal?.aborted) {
      return done({
        status: "cancelled",
        iterations: initialIterations,
        costUsd: initialCostUsd,
        sessionId: initialSessionId,
        finalVerify: { code: -1, output: "cancelled" },
      });
    }
    // The command could not be run at all.
    const result: LoopResult = {
      status: "verify_error",
      iterations: initialIterations,
      costUsd: initialCostUsd,
      sessionId: initialSessionId,
      finalVerify: { code: -1, output: "verify command could not be run" },
    };
    return done(result);
  }
  if (preVerify.code === 0) {
    const result: LoopResult = {
      status: "passed",
      iterations: initialIterations,
      costUsd: initialCostUsd,
      sessionId: initialSessionId,
      finalVerify: preVerify,
    };
    return done(result);
  }
  persist({ lastVerify: preVerify });

  // --- Iterate run → verify → continue. ------------------------------------
  let sessionId = initialSessionId;
  let costUsd = initialCostUsd;
  let lastVerify = preVerify;
  let previousDiagnostics = parseVerifyDiagnostics(preVerify.output);
  let previousWorkspace = workspaceFingerprint(opts.workspace);
  let iterations = initialIterations;

  for (let i = iterations + 1; i <= maxIterations; i++) {
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
        : `\`${opts.verifyCommand}\` still fails:\n\n${diagnosticPrompt(previousDiagnostics, lastVerify.output)}\n\nFix the root cause so it passes.`;

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
    persist({ iterations: i, costUsd, sessionId });
    emit({ type: "run.completed", iteration: i, costUsd });

    // Verify the run's effect.
    let v: { code: number; output: string };
    try {
      v = await verify(
        opts.workspace,
        opts.verifyCommand,
        opts.signal,
        liveVerifyOutput(i, emit),
      );
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
    const diagnostics = parseVerifyDiagnostics(v.output);
    const currentWorkspace = workspaceFingerprint(opts.workspace);
    persist({ iterations: i, costUsd, sessionId, lastVerify: v });
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
    // Structured diagnostics ignore incidental timing/format noise. Pair them
    // with repository content so repeated edits still count as progress.
    const sameFailure = diagnostics.fingerprint === previousDiagnostics.fingerprint;
    const sameWorkspace = currentWorkspace !== null && previousWorkspace !== null
      ? currentWorkspace === previousWorkspace
      : !filesChangedThisRun;
    if (sameFailure && sameWorkspace) {
      return done({ status: "no_progress", iterations: i, costUsd, sessionId, finalVerify: v });
    }
    previousDiagnostics = diagnostics;
    previousWorkspace = currentWorkspace;
  }

  return done({ status: "exhausted", iterations, costUsd, sessionId, finalVerify: lastVerify });
}

export async function resumeAutoLoop(
  deps: AgentCoreDeps,
  loopId: string,
  opts: Omit<LoopOptions, "task" | "verifyCommand" | "maxIterations" | "costBudgetUsd" | "resumeState"> & {
    workspace: string;
  },
): Promise<LoopResult> {
  const state = loadLoopState(opts.workspace, loopId);
  if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
  return runAutoLoop(deps, {
    ...opts,
    task: state.task,
    workspace: state.workspace,
    verifyCommand: state.verifyCommand,
    maxIterations: state.maxIterations,
    ...(state.costBudgetUsd !== null ? { costBudgetUsd: state.costBudgetUsd } : {}),
    resumeState: state,
  });
}
