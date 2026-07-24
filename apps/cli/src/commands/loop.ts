import {
  MAX_LOOP_ITERATIONS,
  WorktreeGitError,
  checkpointWorktree,
  createWorktreePatch,
  enqueueLoopControl,
  isLoopLeaseActive,
  listGitWorktrees,
  mergeWorktree,
  listLoopStates,
  loadLoopState,
  readLoopHistory,
  recoverInterruptedLoops,
  readFileIfExists,
  loadAgentDefinitions,
  removeLoopState,
  resumeAutoLoop,
  runAutoLoop,
  runLoopDag,
  type LoopDagNode,
  type LoopEvent,
  type LoopResult,
  type LoopRequirementMode,
} from "@seekforge/core";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatCostUsd } from "@seekforge/shared/format";
import { createCliAgentDeps, prepareMcp } from "../agent-factory.js";
import { dim, fail, green, red } from "../colors.js";
import { loadConfig } from "../config.js";
import { t } from "../i18n.js";
import { ensureWorkspaceAuthorized } from "./run.js";
import {
  cleanupLoopWorktree,
  createLoopWorktree,
  formatLoopWorktree,
  resolveLoopRepository,
  type LoopWorktree,
} from "../loop-worktree.js";

export type LoopOptions = {
  /** Verify command; exit 0 == success. Required. */
  verify: string;
  /** Max run iterations (default 8). */
  maxIters?: number;
  /** Cumulative cost cap in USD. */
  budget?: number;
  tokenBudget?: number;
  maxDurationSeconds?: number;
  maxVerifyRuns?: number;
  verifyTimeoutSeconds?: number;
  agentTimeoutSeconds?: number;
  agentRetries?: number;
  verifyStages?: string[];
  stablePasses?: number;
  flakyRetries?: number;
  noProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  deliver?: "checkpoint" | "merge" | "patch" | "pr";
  /** Run autonomously (acceptEdits). The loop is autonomous regardless. */
  yes?: boolean;
  /** Override model. */
  model?: string;
  /** Named config profile to overlay (CLI --profile / SEEKFORGE_PROFILE). */
  profile?: string;
  /** Run in a retained isolated worktree, optionally with a user-facing name. */
  worktree?: boolean | string;
  requirements?: LoopRequirementMode;
};

export type LoopResumeOptions = Omit<
  LoopOptions,
  | "verify"
  | "worktree"
  | "maxIters"
  | "budget"
  | "tokenBudget"
  | "maxDurationSeconds"
  | "maxVerifyRuns"
  | "verifyTimeoutSeconds"
  | "agentTimeoutSeconds"
  | "agentRetries"
  | "requirements"
  | "verifyStages"
  | "stablePasses"
  | "flakyRetries"
  | "noProgressRecoveries"
  | "rollbackOnRegression"
  | "deliver"
> & {
  addIters?: number;
  addBudget?: number;
  addTokens?: number;
  addDurationSeconds?: number;
  addVerifyRuns?: number;
  approveRequirements?: boolean;
};

const TAIL_LINES = 6;

/** Last N non-empty lines of verify output, trimmed — for compact progress lines. */
export function outputTail(output: string, lines = TAIL_LINES): string {
  const all = output.replace(/\s+$/, "").split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

/**
 * Pure LoopEvent → human line(s) formatter (no color, no I/O) so it can be unit
 * tested. The command wraps the result with color before printing. `loop.done`
 * returns multiple lines (the summary block); other events return one line.
 */
export function formatLoopEvent(event: LoopEvent): string {
  switch (event.type) {
    case "iteration.start":
      return t("cmd.loop.iterationStart", { n: event.iteration });
    case "run.completed":
      return t("cmd.loop.runCompleted", { n: event.iteration, cost: event.costUsd.toFixed(4) });
    case "verify.output":
      return event.chunk;
    case "verify": {
      const head = event.passed
        ? t("cmd.loop.verifyPassed", { n: event.iteration })
        : t("cmd.loop.verifyFailed", { n: event.iteration, code: event.code });
      const tail = outputTail(event.output);
      return tail ? `${head}\n${tail}` : head;
    }
    case "verify.stage.started":
      return `  verifier ${event.stageId} · attempt ${event.attempt}`;
    case "verify.stage.completed":
      return `  ${event.result.code === 0 ? "✓" : "✗"} verifier ${event.result.id} · ${event.result.durationMs}ms${event.result.flaky ? " · flaky" : ""}`;
    case "verify.flaky":
      return `Warning: verifier ${event.stageId} passed after ${event.attempts} attempts (flaky)`;
    case "loop.paused":
      return `Loop paused at boundary ${event.iteration}`;
    case "loop.resumed":
      return `Loop resumed at boundary ${event.iteration}`;
    case "loop.steered":
      return `Loop accepted ${event.count} guidance message(s)`;
    case "loop.recovery":
      return `Loop recovery ${event.attempt} after ${event.reason}`;
    case "loop.snapshot":
      return `  snapshot ${event.snapshot.iteration} · ${event.snapshot.failedTests} parsed failure(s)`;
    case "loop.rollback":
      return `  rollback ${event.iteration} · restored ${event.restored.length}, deleted ${event.deleted.length}`;
    case "requirements.started":
      return event.phase === "analysis" ? t("cmd.loop.reqAnalyzing") : t("cmd.loop.reqReviewing");
    case "requirements.completed":
      return t("cmd.loop.reqCompleted", {
        reqs: event.spec.requirements.length,
        criteria: event.spec.acceptanceCriteria.length,
        approval: event.approvalRequired ? t("cmd.loop.reqApprovalSuffix") : "",
      });
    case "requirements.reviewed":
      return event.review.complete
        ? t("cmd.loop.reqReviewPassed")
        : t("cmd.loop.reqReviewIncomplete", {
            gaps: event.review.gaps.join("; ") || t("cmd.loop.reqGapsMissing"),
          });
    case "loop.warning":
      return `Warning: ${event.message}`;
    case "loop.done":
      return formatSummary(event.result);
  }
}

/** Multi-line summary block printed once the loop finishes. */
export function formatSummary(result: LoopResult): string {
  const lines = [
    t("cmd.loop.summaryHeader"),
    t("cmd.loop.summaryStatus", { status: result.status }),
    t("cmd.loop.summaryIterations", { n: result.iterations }),
    t("cmd.loop.summaryCost", { cost: result.costUsd.toFixed(4) }),
  ];
  if (result.loopId) {
    const resume =
      result.status === "requirements_pending"
        ? `seekforge loop-resume ${result.loopId} --approve-requirements`
        : `seekforge loop-resume ${result.loopId}`;
    lines.push(`loop: ${result.loopId} (${resume})`);
    lines.push(`log: .seekforge/loops/${result.loopId}.log`);
  }
  if (result.sessionId) {
    lines.push(
      t("cmd.loop.summarySession", { id: result.sessionId }),
      t("cmd.loop.summaryHint", { id: result.sessionId }),
    );
  }
  return lines.join("\n");
}

/** Process exit code for non-success Loop outcomes; passed leaves the current code untouched. */
export function loopExitCode(status: LoopResult["status"]): 1 | 2 | undefined {
  if (status === "requirements_pending") return 2;
  return status === "passed" ? undefined : 1;
}

export function verificationPlanFromOptions(opts: Pick<LoopOptions, "verify" | "verifyStages">) {
  if (!opts.verifyStages?.length) return undefined;
  const ids = new Set(["verify"]);
  return [
    { id: "verify", command: opts.verify },
    ...opts.verifyStages.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid --verify-stage ${JSON.stringify(value)}; expected id=command`);
      }
      const id = value.slice(0, separator);
      const command = value.slice(separator + 1);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || ids.has(id)) {
        throw new Error(`Invalid or duplicate --verify-stage id: ${id}`);
      }
      if (command.trim() === "" || command.length > 8_192) throw new Error(`Invalid --verify-stage command: ${id}`);
      ids.add(id);
      return { id, command };
    }),
  ];
}

export async function loopCommand(task: string, opts: LoopOptions): Promise<void> {
  if (task.trim() === "") {
    fail("Loop task must be non-empty");
    process.exitCode = 1;
    return;
  }
  if (opts.verify.trim() === "") {
    fail("Loop verify command must be non-empty");
    process.exitCode = 1;
    return;
  }
  if (opts.maxIters !== undefined && opts.maxIters > MAX_LOOP_ITERATIONS) {
    fail(`--max-iters must be between 1 and ${MAX_LOOP_ITERATIONS}`);
    process.exitCode = 1;
    return;
  }
  try {
    verificationPlanFromOptions(opts);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  let basePath = process.cwd();
  if (opts.worktree !== undefined && opts.worktree !== false) {
    try {
      basePath = (await resolveLoopRepository(basePath)).basePath;
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  const preflight = await preflightLoop(basePath, opts);
  if (!preflight) return;
  let worktree: LoopWorktree | undefined;
  if (opts.worktree !== undefined && opts.worktree !== false) {
    try {
      worktree = await createLoopWorktree(basePath, typeof opts.worktree === "string" ? opts.worktree : undefined);
      console.log(formatLoopWorktree(worktree));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      return;
    }
  }
  await executeLoop(task, opts, worktree?.path ?? basePath, undefined, preflight);
}

type ResumeAutoLoop = (
  deps: Parameters<typeof runAutoLoop>[0],
  loopId: string,
  opts: {
    workspace: string;
    signal?: AbortSignal;
    onEvent?: (event: LoopEvent) => void;
    model?: string;
    planModel?: string;
    escalateOnFailure?: boolean;
    additionalIterations?: number;
    additionalCostBudgetUsd?: number;
    additionalTokenBudget?: number;
    additionalDurationMs?: number;
    additionalVerifyRuns?: number;
    approveRequirements?: boolean;
  },
) => Promise<LoopResult>;

export function coreResumeAutoLoop(): ResumeAutoLoop {
  return resumeAutoLoop;
}

export async function loopResumeCommand(loopId: string, opts: LoopResumeOptions): Promise<void> {
  const workspace = await findLoopWorkspace(loopId);
  if (workspace) await executeLoop(loopId, opts, workspace, coreResumeAutoLoop());
}

export function resumeExtensionOptions(opts: LoopResumeOptions): {
  additionalIterations?: number;
  additionalCostBudgetUsd?: number;
  additionalTokenBudget?: number;
  additionalDurationMs?: number;
  additionalVerifyRuns?: number;
} {
  return {
    ...(opts.addIters !== undefined ? { additionalIterations: opts.addIters } : {}),
    ...(opts.addBudget !== undefined ? { additionalCostBudgetUsd: opts.addBudget } : {}),
    ...(opts.addTokens !== undefined ? { additionalTokenBudget: opts.addTokens } : {}),
    ...(opts.addDurationSeconds !== undefined
      ? { additionalDurationMs: Math.round(opts.addDurationSeconds * 1_000) }
      : {}),
    ...(opts.addVerifyRuns !== undefined ? { additionalVerifyRuns: opts.addVerifyRuns } : {}),
    ...(opts.approveRequirements !== undefined ? { approveRequirements: opts.approveRequirements } : {}),
  };
}

export function formatLoopState(state: ReturnType<typeof listLoopStates>[number]): string {
  return [
    `loop: ${state.loopId}`,
    `status: ${state.status}`,
    `task: ${state.task}`,
    `iterations: ${state.iterations}/${state.maxIterations}`,
    `cost: ${formatCostUsd(state.costUsd)}${state.costBudgetUsd === null ? "" : ` / ${formatCostUsd(state.costBudgetUsd)}`}`,
    `tokens: ${state.tokensUsed ?? 0}${state.tokenBudget == null ? "" : ` / ${state.tokenBudget}`}`,
    `elapsed: ${state.elapsedMs ?? 0}ms${state.maxDurationMs == null ? "" : ` / ${state.maxDurationMs}ms`}`,
    `verifies: ${state.verifyRuns ?? 0}${state.maxVerifyRuns == null ? "" : ` / ${state.maxVerifyRuns}`}`,
    `updated: ${state.updatedAt}`,
    `workspace: ${state.workspace}`,
    `verify: ${state.verifyCommand}`,
    `requirements: ${state.requirementMode ?? "quick"}${state.requirements ? ` (${state.requirements.requirements.length} requirements, ${state.acceptanceReview?.complete ? "accepted" : "pending acceptance"})` : ""}`,
  ].join("\n");
}

export async function loopListCommand(): Promise<void> {
  try {
    const states = (await loopWorkspaces()).flatMap((workspace) => listLoopStates(workspace));
    if (states.length === 0) {
      console.log("No persisted loops.");
      return;
    }
    console.log(states.map((state) => formatLoopState(state)).join("\n\n"));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function loopShowCommand(loopId: string): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : undefined;
    if (!state) {
      fail(`Persisted loop not found or invalid: ${loopId}`);
      process.exitCode = 1;
      return;
    }
    console.log(formatLoopState(state));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function loopHistoryCommand(loopId: string, opts: { after?: number; limit?: number } = {}): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    if (!workspace) throw new Error(`Persisted loop not found: ${loopId}`);
    const entries = readLoopHistory(workspace, loopId, { afterSeq: opts.after, limit: opts.limit });
    if (entries.length === 0) {
      console.log("No loop history events.");
      return;
    }
    console.log(entries.map((entry) => JSON.stringify(entry)).join("\n"));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function loopRecoverCommand(): Promise<void> {
  try {
    const recovered = (await loopWorkspaces()).flatMap((workspace) => recoverInterruptedLoops(workspace));
    if (recovered.length === 0) {
      console.log("No interrupted loops found.");
      return;
    }
    console.log(recovered.map((state) => `${state.loopId}\tinterrupted\t${state.workspace}`).join("\n"));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function loopControlCommand(
  loopId: string,
  command: { operation: "pause" | "resume" } | { operation: "steer"; message: string },
): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : null;
    if (
      !workspace ||
      !state ||
      (state.status !== "running" && state.status !== "paused") ||
      !state.controlRunId ||
      !isLoopLeaseActive(workspace, loopId)
    ) {
      fail(`No active Loop can accept controls: ${loopId}`);
      process.exitCode = 1;
      return;
    }
    await enqueueLoopControl(workspace, loopId, state.controlRunId, command);
    const current = loadLoopState(workspace, loopId);
    if (!current || current.controlRunId !== state.controlRunId || !isLoopLeaseActive(workspace, loopId)) {
      fail(`Loop stopped before the control was accepted: ${loopId}`);
      process.exitCode = 1;
      return;
    }
    console.log(
      command.operation === "steer"
        ? `Queued guidance for Loop: ${loopId}`
        : `Queued ${command.operation} for Loop: ${loopId}`,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopDagCommand(
  file: string,
  opts: {
    budget?: number;
    tokenBudget?: number;
    maxDurationSeconds?: number;
    yes?: boolean;
    model?: string;
    profile?: string;
  },
): Promise<void> {
  const workspace = process.cwd();
  const preflight = await preflightLoop(workspace, opts);
  if (!preflight) return;
  const raw = readFileIfExists(resolve(workspace, file), 512 * 1024);
  if (raw === undefined) {
    fail(`Loop DAG file not found: ${file}`);
    process.exitCode = 1;
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    fail(`Loop DAG file is not valid JSON: ${file}`);
    process.exitCode = 1;
    return;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Array.isArray((value as { nodes?: unknown }).nodes)
  ) {
    fail("Loop DAG must be an object with a nodes array");
    process.exitCode = 1;
    return;
  }
  const nodes = (value as { nodes: unknown[] }).nodes.map((node): LoopDagNode => {
    if (typeof node !== "object" || node === null || Array.isArray(node))
      throw new Error("Loop DAG nodes must be objects");
    const item = node as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.task !== "string" || typeof item.verifyCommand !== "string") {
      throw new Error("Each Loop DAG node requires string id, task, and verifyCommand fields");
    }
    if (
      item.dependsOn !== undefined &&
      (!Array.isArray(item.dependsOn) || !item.dependsOn.every((id) => typeof id === "string"))
    ) {
      throw new Error(`Loop DAG node ${item.id} dependsOn must be a string array`);
    }
    return {
      id: item.id,
      task: item.task,
      verifyCommand: item.verifyCommand,
      ...(Array.isArray(item.dependsOn) ? { dependsOn: item.dependsOn as string[] } : {}),
    };
  });
  const { config, model } = preflight;
  const mcp = await prepareMcp(config, workspace);
  const { deps, dispose } = createCliAgentDeps({
    config,
    workspace,
    pluginContributions: mcp.pluginContributions,
    model,
    mcpToolSpecs: mcp.specs,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(workspace, mcp.pluginContributions),
  });
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const results = await runLoopDag(deps, {
      workspace,
      nodes,
      maxConcurrency: 1,
      ...(opts.budget !== undefined ? { costBudgetUsd: opts.budget } : {}),
      ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
      ...(opts.maxDurationSeconds !== undefined ? { maxDurationMs: Math.round(opts.maxDurationSeconds * 1_000) } : {}),
      signal: controller.signal,
      onNodeEvent: (nodeId, event) => console.log(`[${nodeId}] ${formatLoopEvent(event)}`),
    });
    console.log(
      results.map((result) => `${result.id}\t${result.status}${result.reason ? `\t${result.reason}` : ""}`).join("\n"),
    );
    if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
  }
}

export async function loopDeleteCommand(loopId: string): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    if (!workspace || !removeLoopState(workspace, loopId)) {
      fail(`Persisted loop not found: ${loopId}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Deleted persisted loop: ${loopId}`);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function loopCleanupCommand(name: string, opts: { force?: boolean }): Promise<void> {
  try {
    const removed = await cleanupLoopWorktree(process.cwd(), name, opts.force === true);
    console.log(
      removed.branchRemoved === false
        ? `Removed loop worktree: ${removed.path}\nRetained branch (remove manually): ${removed.branch}`
        : `Removed loop worktree: ${removed.path}\nRemoved branch: ${removed.branch}`,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function executeLoop(
  taskOrLoopId: string,
  opts: LoopOptions | LoopResumeOptions,
  projectPath: string,
  resume?: ResumeAutoLoop,
  prepared?: LoopPreflight,
): Promise<void> {
  const preflight = prepared ?? (await preflightLoop(projectPath, opts));
  if (!preflight) return;
  const { config, model } = preflight;
  await runPreparedLoop(taskOrLoopId, opts, projectPath, config, model, resume);
}

type LoopPreflight = { config: ReturnType<typeof loadConfig>; model: string | undefined };

async function preflightLoop(
  projectPath: string,
  opts: LoopOptions | LoopResumeOptions,
): Promise<LoopPreflight | undefined> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(projectPath, undefined, opts.profile);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = (err as { hint?: string }).hint;
    fail(msg, hint ? { hint } : undefined);
    return;
  }

  const model = opts.model ?? config.model;
  if (model === "deepseek-reasoner") {
    fail(t("err.reasonerNoToolCall"), { hint: t("err.reasonerHint") });
    return;
  }
  if (!config.apiKey) {
    fail(t("err.noApiKey"), { hint: t("err.noApiKeyHint2") });
    return;
  }

  // Per-folder access consent, same gate as `run`/`repl` — the loop edits files
  // autonomously (acceptEdits, no per-tool prompt), so it must NOT bypass it.
  if (!(await ensureWorkspaceAuthorized(projectPath, { yes: opts.yes === true, machine: false }))) {
    return;
  }
  return { config, model };
}

async function runPreparedLoop(
  taskOrLoopId: string,
  opts: LoopOptions | LoopResumeOptions,
  projectPath: string,
  config: ReturnType<typeof loadConfig>,
  model: string | undefined,
  resume?: ResumeAutoLoop,
): Promise<void> {
  // The loop is inherently autonomous: it must apply edits without a human in
  // the loop. We always run in acceptEdits. Without -y we still proceed (that
  // is the sensible default for a "drive to green" command) but print a note.
  if (!opts.yes) console.error(dim(t("cmd.loop.autoApproveNote")));

  // Spawn MCP servers first so their tool specs make it into the dispatcher.
  const mcp = await prepareMcp(config, projectPath);

  // Build the SAME deps run/repl use (provider, dispatcher, runtime, allowlist,
  // permission rules, hooks, sandbox, planModel/escalation, subagents). The
  // loop never prompts, so confirm denies anything not already permitted.
  const { deps, dispose } = createCliAgentDeps({
    config,
    workspace: projectPath,
    pluginContributions: mcp.pluginContributions,
    model,
    mcpToolSpecs: mcp.specs,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(projectPath, mcp.pluginContributions),
  });

  // Ctrl-C: cooperative stop — abort the signal so the loop returns "cancelled"
  // and the trace is kept (mirrors run.ts). A second press force-exits.
  const controller = new AbortController();
  const onSigint = () => {
    if (controller.signal.aborted) process.exit(130);
    console.error(t("render.cancelling"));
    controller.abort();
  };
  process.on("SIGINT", onSigint);

  try {
    const verificationPlan = resume ? undefined : verificationPlanFromOptions(opts as LoopOptions);
    const common = {
      ...(model ? { model } : {}),
      ...(config.planModel ? { planModel: config.planModel } : {}),
      ...(config.escalateOnFailure ? { escalateOnFailure: true } : {}),
      signal: controller.signal,
      onEvent: (event: LoopEvent) => printEvent(event),
    };
    const result = resume
      ? await resume(deps, taskOrLoopId, {
          workspace: projectPath,
          ...resumeExtensionOptions(opts as LoopResumeOptions),
          ...common,
        })
      : await runAutoLoop(deps, {
          task: taskOrLoopId,
          workspace: projectPath,
          verifyCommand: (opts as LoopOptions).verify,
          ...(verificationPlan ? { verificationPlan } : {}),
          ...((opts as LoopOptions).stablePasses !== undefined
            ? { stablePasses: (opts as LoopOptions).stablePasses }
            : {}),
          ...((opts as LoopOptions).flakyRetries !== undefined
            ? { flakyRetries: (opts as LoopOptions).flakyRetries }
            : {}),
          ...((opts as LoopOptions).noProgressRecoveries !== undefined
            ? { maxNoProgressRecoveries: (opts as LoopOptions).noProgressRecoveries }
            : {}),
          ...((opts as LoopOptions).rollbackOnRegression ? { rollbackOnRegression: true } : {}),
          maxIterations: (opts as LoopOptions).maxIters ?? 8,
          ...((opts as LoopOptions).budget !== undefined ? { costBudgetUsd: (opts as LoopOptions).budget } : {}),
          ...((opts as LoopOptions).tokenBudget !== undefined
            ? { tokenBudget: (opts as LoopOptions).tokenBudget }
            : {}),
          ...((opts as LoopOptions).maxDurationSeconds !== undefined
            ? { maxDurationMs: Math.round((opts as LoopOptions).maxDurationSeconds! * 1_000) }
            : {}),
          ...((opts as LoopOptions).maxVerifyRuns !== undefined
            ? { maxVerifyRuns: (opts as LoopOptions).maxVerifyRuns }
            : {}),
          ...((opts as LoopOptions).verifyTimeoutSeconds !== undefined
            ? { verifyTimeoutMs: Math.round((opts as LoopOptions).verifyTimeoutSeconds! * 1_000) }
            : {}),
          ...((opts as LoopOptions).agentTimeoutSeconds !== undefined
            ? { agentTimeoutMs: Math.round((opts as LoopOptions).agentTimeoutSeconds! * 1_000) }
            : {}),
          ...((opts as LoopOptions).agentRetries !== undefined
            ? { maxAgentRetries: (opts as LoopOptions).agentRetries }
            : {}),
          approvalMode: "acceptEdits",
          ...((opts as LoopOptions).requirements ? { requirementMode: (opts as LoopOptions).requirements } : {}),
          ...common,
        });
    // Distinct exit code: requirements_pending is a deliberate pause awaiting
    // approval, not a failure — scripts resume with --approve-requirements
    // rather than treating it like an exhausted/failed loop.
    const exitCode = loopExitCode(result.status);
    if (result.status === "passed" && (opts as LoopOptions).deliver) {
      await deliverLoop(projectPath, result.loopId ?? "loop", (opts as LoopOptions).deliver!);
    }
    if (exitCode !== undefined) process.exitCode = exitCode;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
  }
}

async function deliverLoop(
  projectPath: string,
  loopId: string,
  mode: "checkpoint" | "merge" | "patch" | "pr",
): Promise<void> {
  const repository = await resolveLoopRepository(projectPath);
  const workspace = resolve(projectPath);
  if (workspace === resolve(repository.basePath))
    throw new Error("Loop delivery requires an isolated retained worktree");
  const entry = (await listGitWorktrees(repository.basePath)).find(
    (candidate) => resolve(candidate.path) === workspace,
  );
  if (!entry?.branch.startsWith("seekforge/loop-"))
    throw new Error("Current workspace is not a retained Loop worktree");
  if (mode === "checkpoint") {
    const committed = await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
    console.log(
      committed ? `Committed Loop worktree: ${entry.branch}` : `Loop worktree already clean: ${entry.branch}`,
    );
    return;
  }
  if (mode === "merge") {
    const merged = await mergeWorktree(repository.basePath, workspace, entry.branch);
    if ("conflict" in merged) throw new Error(`Loop delivery merge conflicted: ${merged.files.join(", ")}`);
    console.log(`Merged Loop worktree branch: ${entry.branch}`);
    return;
  }
  if (mode === "pr") {
    await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
    const base = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repository.basePath,
      encoding: "utf8",
    });
    if (base.status !== 0 || !base.stdout.trim())
      throw new Error(base.stderr.trim() || "Could not resolve base branch");
    const pushed = spawnSync("git", ["push", "-u", "origin", entry.branch], { cwd: workspace, encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(pushed.stderr.trim() || "Could not push Loop worktree branch");
    const pr = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--base",
        base.stdout.trim(),
        "--head",
        entry.branch,
        "--title",
        `Loop: ${loopId}`,
        "--body",
        `Automated Loop delivery for ${loopId}. Verification passed before delivery.`,
      ],
      { cwd: workspace, encoding: "utf8" },
    );
    if (pr.error && (pr.error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("GitHub CLI (gh) is required");
    if (pr.status !== 0) throw new Error(pr.stderr.trim() || "Could not create draft pull request");
    console.log(`Created draft pull request: ${pr.stdout.trim()}`);
    return;
  }
  await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
  const patch = await createWorktreePatch(repository.basePath, entry.branch);
  if (!patch) throw new Error("Loop worktree has no changes to deliver");
  const target = join(workspace, ".seekforge", "loops", `${loopId}.patch`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, patch, { encoding: "utf8", mode: 0o600 });
  console.log(`Wrote Loop patch: ${target}`);
}

async function loopWorkspaces(): Promise<string[]> {
  try {
    return (await resolveLoopRepository(process.cwd())).workspaces;
  } catch (error) {
    if (error instanceof WorktreeGitError && error.code === "not_a_git_repo") {
      return [process.cwd()];
    }
    throw error;
  }
}

async function findLoopWorkspace(loopId: string, reportMissing = true): Promise<string | undefined> {
  try {
    const matches = (await loopWorkspaces()).filter((workspace) => loadLoopState(workspace, loopId));
    if (matches.length > 1) {
      throw new Error(`Persisted loop id is ambiguous across workspaces: ${loopId}`);
    }
    if (matches[0]) return matches[0];
    if (reportMissing) {
      fail(`Persisted loop not found or invalid: ${loopId}`);
      process.exitCode = 1;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
  return undefined;
}

/** Renders a LoopEvent to the terminal with color (the command's only I/O). */
function printEvent(event: LoopEvent): void {
  const text = formatLoopEvent(event);
  if (event.type === "verify.output") {
    const stream = event.stream === "stderr" ? process.stderr : process.stdout;
    stream.write(text);
  } else if (event.type === "verify") {
    console.log(event.passed ? green(text) : red(text));
  } else if (event.type === "loop.done") {
    console.log(event.result.status === "passed" ? green(text) : red(text));
  } else {
    console.log(text);
  }
}
