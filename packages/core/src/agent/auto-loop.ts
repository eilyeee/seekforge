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
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ToolError } from "../tools/errors.js";
import { runShellCommand } from "../tools/run-command.js";
import {
  acquireLoopLease,
  appendLoopLog,
  createLoopState,
  loadLoopState,
  saveLoopState,
  type LoopState,
} from "./loop-state.js";
import { createAgentCore, type AgentCoreDeps } from "./loop.js";
import { parseVerifyDiagnostics, type VerifyDiagnostics } from "./verify-diagnostics.js";
import { MAX_LOOP_ITERATIONS, MAX_LOOP_WARNING_LENGTH, MAX_VERIFY_DIAGNOSTIC_INPUT } from "./loop-constants.js";
import { detectActionCycle } from "./loop-logic.js";

export type LoopStatus =
  | "passed" // verification command exited 0
  | "exhausted" // hit maxIterations
  | "no_progress" // stuck: equivalent diagnostics + unchanged workspace
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
  | { type: "loop.warning"; warning: "persistence"; message: string }
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

function diagnosticAggregate(value: string): string {
  if (value.length <= MAX_VERIFY_DIAGNOSTIC_INPUT) return value;
  const head = Math.floor(MAX_VERIFY_DIAGNOSTIC_INPUT / 2);
  return `${value.slice(0, head)}\n... verifier output omitted ...\n${value.slice(-(MAX_VERIFY_DIAGNOSTIC_INPUT - head))}`;
}

async function captureVerify(
  verify: NonNullable<LoopOptions["verify"]>, workspace: string, command: string,
  signal: AbortSignal | undefined, onOutput: (stream: "stdout" | "stderr", chunk: string) => void,
): Promise<{ result: { code: number; output: string }; diagnostics: string }> {
  let streamed = "";
  const capture = (stream: "stdout" | "stderr", chunk: string): void => {
    streamed = diagnosticAggregate(streamed + chunk);
    onOutput(stream, chunk);
  };
  const raw = await verify(workspace, command, signal, capture);
  const aggregate = diagnosticAggregate(streamed ? `${raw.output}\n${streamed}` : raw.output);
  return { result: { code: raw.code, output: tail(streamed || raw.output) }, diagnostics: aggregate };
}

function workspaceFingerprint(workspace: string): string | null {
  const hashFile = (hash: ReturnType<typeof createHash>, absolute: string, path: string): void => {
    const stat = lstatSync(absolute);
    hash.update(`\0${path}\0${stat.mode}\0${stat.size}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(absolute));
      return;
    }
    if (stat.isDirectory()) {
      try {
        hash.update(execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
          cwd: absolute,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }));
      } catch {
        hash.update("<unreadable-directory>");
      }
      return;
    }
    if (!stat.isFile()) return;
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(stat.size, 1), 1_000_000));
    const fd = openSync(absolute, "r");
    try {
      let position = 0;
      for (;;) {
        const bytes = readSync(fd, buffer, 0, buffer.length, position);
        if (bytes === 0) break;
        hash.update(buffer.subarray(0, bytes));
        position += bytes;
      }
    } finally {
      closeSync(fd);
    }
  };
  try {
    const hash = createHash("sha256");
    const status = execFileSync("git", ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      cwd: workspace,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pathCommands = [
      ["diff", "--name-only", "-z"],
      ["diff", "--cached", "--name-only", "-z"],
      ["ls-files", "--others", "--exclude-standard", "-z"],
    ];
    const paths = [...new Set(pathCommands.flatMap((args) =>
      execFileSync("git", args, {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).split("\0"),
    ).filter((path) =>
      Boolean(path) &&
      !path.startsWith(".seekforge/loops/") &&
      !path.startsWith(".seekforge/sessions/") &&
      !path.startsWith(".seekforge/uploads/"),
    ))].sort();
    const relevantStatus = status.split("\0").filter((record) =>
      !record.includes(" .seekforge/loops/") &&
      !record.includes(" .seekforge/sessions/") &&
      !record.includes(" .seekforge/uploads/"),
    ).join("\0");
    hash.update(relevantStatus);
    for (const path of paths) {
      try {
        hashFile(hash, join(workspace, path), path);
      } catch {
        hash.update("<unreadable>");
      }
    }
    return hash.digest("hex");
  } catch {
    try {
      const hash = createHash("sha256");
      const visit = (directory: string, relative = ""): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = relative ? `${relative}/${entry.name}` : entry.name;
          if (path === ".git" || path.startsWith(".git/") ||
              path.startsWith(".seekforge/loops/") || path.startsWith(".seekforge/sessions/") ||
              path.startsWith(".seekforge/uploads/")) continue;
          const absolute = join(workspace, path);
          if (entry.isDirectory()) visit(absolute, path);
          else if (entry.isFile() || entry.isSymbolicLink()) {
            hashFile(hash, absolute, path);
          }
        }
      };
      visit(workspace);
      return hash.digest("hex");
    } catch {
      return null;
    }
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

function verifyErrorOutput(error: unknown): string {
  if (error instanceof ToolError) {
    const detail = error.detail as { stdout?: string; stderr?: string } | undefined;
    return tail([detail?.stdout, detail?.stderr, error.message].filter(Boolean).join("\n"));
  }
  return tail(error instanceof Error ? error.message : String(error));
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
    return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
  } catch (err) {
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
  const persistenceEnabled = opts.persist !== false;
  const loopId = opts.resumeState?.loopId ?? opts.loopId ?? `loop-${randomUUID()}`;
  // Mirror the event stream into an append-only `.seekforge/loops/<id>.log`
  // (JSONL) so the run has a durable record, not just ephemeral terminal output.
  // Logging is best-effort and must never break the loop; a persistently broken
  // directory still surfaces via the state-persistence warning below.
  const emit = (event: LoopEvent): void => {
    if (persistenceEnabled) {
      try { appendLoopLog(opts.workspace, loopId, event); } catch { /* observability only */ }
    }
    opts.onEvent?.(event);
  };
  const lease = acquireLoopLease(opts.workspace, loopId, persistenceEnabled);
  try {
    return await runAutoLoopWithLease(deps, opts, emit, persistenceEnabled, loopId);
  } finally {
    lease.release();
  }
}

async function runAutoLoopWithLease(
  deps: AgentCoreDeps,
  opts: LoopOptions,
  emit: (event: LoopEvent) => void,
  persistenceEnabled: boolean,
  loopId: string,
): Promise<LoopResult> {
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

  if (opts.model && opts.model !== deps.provider.model && !deps.providerForModel) {
    throw new Error(`Cannot select loop model without providerForModel: ${opts.model}`);
  }

  const agent = createAgentCore({
    ...deps,
    ...(opts.model && deps.providerForModel ? { provider: deps.providerForModel(opts.model) } : {}),
    ...(opts.escalateOnFailure !== undefined ? { escalateOnFailure: opts.escalateOnFailure } : {}),
    ...(opts.planModel ? { planModel: opts.planModel } : {}),
  });

  let state: LoopState | undefined = persistenceEnabled ? opts.resumeState : undefined;
  let warnedPersistence = false;
  const persistenceWarning = (error: unknown): void => {
    if (warnedPersistence) return;
    warnedPersistence = true;
    const detail = error instanceof Error ? error.message : String(error);
    emit({ type: "loop.warning", warning: "persistence", message: detail.slice(0, MAX_LOOP_WARNING_LENGTH) });
  };
  if (persistenceEnabled && state === undefined) {
    try {
      state = createLoopState({
        loopId,
        task: opts.task,
        workspace: opts.workspace,
        verifyCommand: opts.verifyCommand,
        maxIterations,
        costBudgetUsd: costBudgetUsd ?? null,
      });
    } catch (error) {
      persistenceWarning(error);
    }
  } else if (state !== undefined) {
    state = { ...state, status: "running", updatedAt: new Date().toISOString() };
    try {
      saveLoopState(opts.workspace, state);
    } catch (error) {
      persistenceWarning(error);
    }
  }
  const persist = (patch: Partial<LoopState>): void => {
    if (state === undefined) return;
    state = { ...state, ...patch, updatedAt: new Date().toISOString() };
    try {
      saveLoopState(opts.workspace, state);
    } catch (error) {
      persistenceWarning(error);
    }
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
  let preVerifyDiagnostics = "";
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
    const captured = await captureVerify(verify,
      opts.workspace,
      opts.verifyCommand,
      opts.signal,
      liveVerifyOutput(0, emit),
    );
    preVerify = captured.result;
    preVerifyDiagnostics = captured.diagnostics;
  } catch (error) {
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
      finalVerify: { code: -1, output: verifyErrorOutput(error) },
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
  let previousDiagnostics = parseVerifyDiagnostics(preVerifyDiagnostics);
  let previousWorkspace = workspaceFingerprint(opts.workspace);
  const progressFingerprints = [
    `${previousDiagnostics.fingerprint}:${previousWorkspace ?? "unknown-workspace"}`,
  ];
  let iterations = initialIterations;

  for (let i = iterations + 1; i <= maxIterations; i++) {
    if (opts.signal?.aborted) {
      return done({ status: "cancelled", iterations, costUsd, sessionId, finalVerify: lastVerify });
    }
    if (costBudgetUsd !== undefined && costUsd >= costBudgetUsd) {
      return done({ status: "budget", iterations, costUsd, sessionId, finalVerify: lastVerify });
    }
    emit({ type: "iteration.start", iteration: i });

    const continuation =
      i === 1 && !sessionId
        ? opts.task
        : `\`${opts.verifyCommand}\` still fails:\n\n${diagnosticPrompt(previousDiagnostics, lastVerify.output)}\n\nFix the root cause so it passes.`;

    let runCost = 0;
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
        if (!sessionId) {
          sessionId = ev.sessionId;
          persist({ costUsd: costUsd + runCost, sessionId });
        }
      } else if (ev.type === "usage.updated") {
        // Cumulative spend within this run. Tracked here so a failed run — which
        // emits no FinalReport — still contributes its real cost to the budget
        // guard below; otherwise repeated expensive failures overshoot silently.
        runCost = ev.usage.costUsd;
        persist({ costUsd: costUsd + runCost, sessionId });
        if (costBudgetUsd !== undefined && costUsd + runCost >= costBudgetUsd) {
          budgetController.abort();
        }
      } else if (ev.type === "session.completed") {
        runCost = ev.report.usage.costUsd;
      }
    }
    costUsd += runCost;
    iterations = i;
    persist({ iterations: i, costUsd, sessionId });
    emit({ type: "run.completed", iteration: i, costUsd });

    // Verify the run's effect.
    let v: { code: number; output: string };
    let verifyDiagnostics = "";
    try {
      const captured = await captureVerify(verify,
        opts.workspace,
        opts.verifyCommand,
        opts.signal,
        liveVerifyOutput(i, emit),
      );
      v = captured.result;
      verifyDiagnostics = captured.diagnostics;
    } catch (error) {
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
        finalVerify: { code: -1, output: verifyErrorOutput(error) },
      };
      return done(result);
    }
    lastVerify = v;
    const diagnostics = parseVerifyDiagnostics(verifyDiagnostics);
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
    const sameWorkspace = currentWorkspace !== null && previousWorkspace !== null &&
      currentWorkspace === previousWorkspace;
    progressFingerprints.push(`${diagnostics.fingerprint}:${currentWorkspace ?? "unknown-workspace"}`);
    if (progressFingerprints.length > 8) progressFingerprints.shift();
    const cyclePeriod = detectActionCycle(progressFingerprints);
    if ((sameFailure && sameWorkspace) || cyclePeriod !== null) {
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
    additionalIterations?: number;
    additionalCostBudgetUsd?: number;
  },
): Promise<LoopResult> {
  const state = loadLoopState(opts.workspace, loopId);
  if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
  if (opts.additionalIterations !== undefined &&
      (!Number.isSafeInteger(opts.additionalIterations) || opts.additionalIterations <= 0)) {
    throw new Error("additionalIterations must be a positive safe integer");
  }
  if (opts.additionalCostBudgetUsd !== undefined &&
      (!Number.isFinite(opts.additionalCostBudgetUsd) || opts.additionalCostBudgetUsd <= 0)) {
    throw new Error("additionalCostBudgetUsd must be a finite positive number");
  }
  const addedIterations = opts.additionalIterations ?? 0;
  const addedBudget = opts.additionalCostBudgetUsd ?? 0;
  const maxIterations = Math.min(MAX_LOOP_ITERATIONS, state.maxIterations + addedIterations);
  const costBudgetUsd = addedBudget > 0
    ? (state.costBudgetUsd ?? state.costUsd) + addedBudget
    : state.costBudgetUsd;
  if (costBudgetUsd !== null && !Number.isFinite(costBudgetUsd)) {
    throw new Error("resulting cost budget must be finite");
  }
  const { additionalIterations: _additionalIterations, additionalCostBudgetUsd: _additionalBudget, ...runOpts } = opts;
  return runAutoLoop(deps, {
    ...runOpts,
    task: state.task,
    workspace: state.workspace,
    verifyCommand: state.verifyCommand,
    maxIterations,
    ...(costBudgetUsd !== null ? { costBudgetUsd } : {}),
    resumeState: { ...state, maxIterations, costBudgetUsd },
  });
}
