import {
  acquireLoopLifecycleLeaseWithPreemption,
  archiveLoopDagResources,
  buildLoopEvidenceReport,
  buildLoopHealthReport,
  compareLoopEvidence,
  MAX_LOOP_ITERATIONS,
  WorktreeGitError,
  checkpointWorktree,
  checkpointWorktreePaths,
  createWorktreePatch,
  discoverLoopVerificationPlan,
  diagnoseLoopCheckpoint,
  enqueueLoopControl,
  exportLoopEvidence,
  hasCompleteLoopDeliveryEvidence,
  isWorktreeDirty,
  isLoopLeaseActive,
  isLoopDeliveryActive,
  inspectLoopDagResources,
  killProcessTree,
  listGitWorktrees,
  mergeWorktree,
  listLoopStates,
  listLoopSpeculationStates,
  loadLoopState,
  promoteLoopDagResult,
  promoteLoopSpeculation,
  pruneLoopDagResources,
  readLoopHistory,
  readLoopVerificationIntelligence,
  analyzeLoopVerificationIntelligence,
  recoverInterruptedLoops,
  pruneLoopStates,
  readFileIfExists,
  loadAgentDefinitions,
  onAbortOnce,
  removeLoopState,
  resumeAutoLoop,
  runAutoLoop,
  runLoopDag,
  runSpeculativeLoop,
  runShellCommand,
  saveLoopState,
  setLoopPriority,
  worktreeChangedPathsSince,
  type LoopEvent,
  type LoopDeliveryMode,
  type LoopDeliveryEvidence,
  type LoopDeliveryCiState,
  type LoopResult,
  type LoopEvidenceFormat,
  type LoopState,
  type LoopRequirementMode,
  type LoopFailureCategory,
} from "@seekforge/core";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatCostUsd } from "@seekforge/shared/format";
import { createCliAgentDeps, prepareMcp } from "../agent-factory.js";
import { dim, fail, green, red } from "../colors.js";
import { loadConfig } from "../config.js";
import { t } from "../i18n.js";
import { ensureWorkspaceAuthorized } from "./run.js";
import { buildCiRepairPrompt, PR_CHECKS_TIMEOUT_MS } from "../resolve.js";
import { createGitHubCiProvider, type LoopCiProvider } from "../ci-provider.js";
import { parseLoopDagInput, parseLoopSpeculationInput } from "../loop-input.js";
import { withLoopAgentRuntime } from "../loop-runtime.js";
import {
  cleanupLoopWorktree,
  createLoopWorktree,
  formatLoopWorktree,
  resolveLoopRepository,
  type LoopWorktree,
} from "../loop-worktree.js";
import { apiKeyEnvVar } from "@seekforge/shared/provider-env";

export type LoopOptions = {
  /** Verify command; exit 0 == success. Required unless autoVerify is enabled. */
  verify?: string;
  autoVerify?: boolean;
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
  adaptiveBudget?: boolean;
  codeReview?: boolean;
  deliver?: LoopDeliveryMode;
  waitCi?: boolean;
  ciRepairs?: number;
  ciRepairBudget?: number;
  /** Run autonomously (acceptEdits). The loop is autonomous regardless. */
  yes?: boolean;
  /** Override model. */
  model?: string;
  modelRoutesByFailureCategory?: Partial<Record<LoopFailureCategory, string[]>>;
  modelEscalationThreshold?: number;
  /** Named config profile to overlay (CLI --profile / SEEKFORGE_PROFILE). */
  profile?: string;
  /** Run in a retained isolated worktree, optionally with a user-facing name. */
  worktree?: boolean | string;
  requirements?: LoopRequirementMode;
  priority?: number;
};

export type LoopResumeOptions = Omit<
  LoopOptions,
  | "verify"
  | "autoVerify"
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
  | "adaptiveBudget"
  | "deliver"
  | "waitCi"
  | "ciRepairs"
  | "ciRepairBudget"
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
      return `${t("cmd.loop.runCompleted", { n: event.iteration, cost: event.costUsd.toFixed(4) })}${
        event.iterationTokens !== undefined
          ? ` · +${event.iterationTokens} tokens · ${event.durationMs ?? 0}ms · ${event.changedPaths?.length ?? 0} path(s)`
          : ""
      }`;
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
    case "loop.model.routed":
      return `  model route · ${event.category} → ${event.model} · streak ${event.consecutiveFailures}${event.reason === "escalated_category" ? " · escalated" : ""}`;
    case "verify.impact":
      return `  verification impact · ${event.decisions.filter((decision) => decision.action === "run").length} run, ${event.decisions.filter((decision) => decision.action === "reuse").length} reused, ${event.decisions.filter((decision) => decision.action === "skip").length} skipped, ${event.decisions.filter((decision) => decision.action === "blocked").length} blocked${event.fullFallback ? " · full" : ""}`;
    case "loop.paused":
      return `Loop paused at boundary ${event.iteration}`;
    case "loop.resumed":
      return `Loop resumed at boundary ${event.iteration}`;
    case "loop.steered":
      return `Loop accepted ${event.count} guidance message(s)`;
    case "loop.recovery":
      return `Loop recovery ${event.attempt} after ${event.reason}${event.strategy ? ` · ${event.category}/${event.strategy}` : ""}`;
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
    case "code_review.started":
      return `Independent code review started at iteration ${event.iteration}`;
    case "code_review.completed":
      return event.review.complete
        ? "Independent code review passed"
        : `Independent code review found ${event.review.findings.length} actionable issue(s)`;
    case "loop.memory.updated":
      return `  working memory updated · iteration ${event.memory.iteration}`;
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
  if (!opts.verify) throw new Error("--verify-stage requires --verify");
  const ids = new Set(["verify"]);
  return [
    { id: "verify", command: opts.verify },
    ...opts.verifyStages.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid --verify-stage ${JSON.stringify(value)}; expected id=command`);
      }
      const selector = value.slice(0, separator);
      const command = value.slice(separator + 1);
      const pathSeparator = selector.indexOf("@");
      const id = pathSeparator === -1 ? selector : selector.slice(0, pathSeparator);
      const paths = pathSeparator === -1 ? undefined : selector.slice(pathSeparator + 1).split(",");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || ids.has(id)) {
        throw new Error(`Invalid or duplicate --verify-stage id: ${id}`);
      }
      if (command.trim() === "" || command.length > 8_192) throw new Error(`Invalid --verify-stage command: ${id}`);
      if (
        paths !== undefined &&
        (paths.length === 0 ||
          paths.length > 64 ||
          paths.some(
            (path) =>
              path.length === 0 ||
              path.length > 512 ||
              path.startsWith("/") ||
              /^[A-Za-z]:[\\/]/.test(path) ||
              path
                .replaceAll("\\", "/")
                .split("/")
                .some((part) => part === "" || part === "." || part === ".."),
          ))
      )
        throw new Error(`Invalid --verify-stage paths: ${id}`);
      ids.add(id);
      return { id, command, ...(paths ? { paths } : {}) };
    }),
  ];
}

export async function loopCommand(task: string, opts: LoopOptions): Promise<void> {
  if (task.trim() === "") {
    fail("Loop task must be non-empty");
    process.exitCode = 1;
    return;
  }
  if (opts.autoVerify === true && opts.verify !== undefined) {
    fail("--auto-verify cannot be combined with --verify");
    process.exitCode = 1;
    return;
  }
  if (opts.autoVerify !== true && !opts.verify?.trim()) {
    fail("Loop requires --verify or --auto-verify");
    process.exitCode = 1;
    return;
  }
  if (opts.autoVerify === true && opts.verifyStages?.length) {
    fail("--auto-verify cannot be combined with --verify-stage");
    process.exitCode = 1;
    return;
  }
  if (opts.maxIters !== undefined && opts.maxIters > MAX_LOOP_ITERATIONS) {
    fail(`--max-iters must be between 1 and ${MAX_LOOP_ITERATIONS}`);
    process.exitCode = 1;
    return;
  }
  if ((opts.ciRepairs ?? 0) > 3) {
    fail("--ci-repairs must be between 0 and 3");
    process.exitCode = 1;
    return;
  }
  if ((opts.waitCi || (opts.ciRepairs ?? 0) > 0) && opts.deliver !== "pr") {
    fail("--wait-ci and --ci-repairs require --deliver pr");
    process.exitCode = 1;
    return;
  }
  if ((opts.ciRepairs ?? 0) > 0 && !opts.waitCi) {
    fail("--ci-repairs requires --wait-ci");
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
  await executeLoop({ kind: "start", task, opts }, worktree?.path ?? basePath, preflight);
}

type ResumeAutoLoop = (
  deps: Parameters<typeof runAutoLoop>[0],
  loopId: string,
  opts: {
    workspace: string;
    signal?: AbortSignal;
    onEvent?: (event: LoopEvent) => void;
    model?: string;
    modelRoutesByFailureCategory?: Partial<Record<LoopFailureCategory, string[]>>;
    modelEscalationThreshold?: number;
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
  if (workspace) {
    await executeLoop({ kind: "resume", loopId, opts, resume: coreResumeAutoLoop() }, workspace);
  }
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
    `priority: ${state.priority ?? 0}`,
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
    `recovery: ${state.recovery ? `${state.recovery.attempts} attempt(s)${state.recovery.nextAttemptAt ? ` · next ${state.recovery.nextAttemptAt}` : ""}${state.recovery.lastError ? ` · ${state.recovery.lastError}` : ""}` : "none"}`,
    `delivery: ${state.delivery ? `${state.delivery.mode}/${state.delivery.status}/${state.delivery.phase ?? "prepared"} (attempts ${state.delivery.attempts})${state.delivery.artifact ? ` · ${state.delivery.artifact}` : ""}${state.delivery.evidence?.revision ? ` · revision ${state.delivery.evidence.revision}` : ""}${state.delivery.evidence?.sha256 ? ` · sha256 ${state.delivery.evidence.sha256}` : ""}${state.delivery.error ? ` · ${state.delivery.error}` : ""}` : "none"}`,
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

export async function loopDiagnoseCommand(loopId: string): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : null;
    if (!workspace || !state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    const history = readLoopHistory(workspace, loopId, { limit: 2_000, tail: true });
    const report = diagnoseLoopCheckpoint(state, history);
    console.log(JSON.stringify(report, null, 2));
    if (!report.healthy) process.exitCode = 1;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export function loopIntelligenceCommand(): void {
  try {
    const entries = readLoopVerificationIntelligence(process.cwd());
    console.log(JSON.stringify({ entries, findings: analyzeLoopVerificationIntelligence(entries) }, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopHealthCommand(loopId: string): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : null;
    if (!workspace || !state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    console.log(JSON.stringify(buildLoopHealthReport(state, readLoopVerificationIntelligence(workspace)), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopEvidenceCommand(
  loopId: string,
  opts: { format?: LoopEvidenceFormat; compare?: string } = {},
): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : null;
    if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    const report = buildLoopEvidenceReport(state);
    if (opts.compare) {
      const otherWorkspace = await findLoopWorkspace(opts.compare, false);
      const other = otherWorkspace ? loadLoopState(otherWorkspace, opts.compare) : null;
      if (!other) throw new Error(`Persisted comparison Loop not found or invalid: ${opts.compare}`);
      console.log(JSON.stringify(compareLoopEvidence(report, buildLoopEvidenceReport(other)), null, 2));
      return;
    }
    console.log(exportLoopEvidence(report, opts.format ?? "json").trimEnd());
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopDagResourcesCommand(
  dagId: string,
  operation: "inspect" | "archive" | "prune" | "promote",
  opts: { dryRun?: boolean; force?: boolean; target?: string } = {},
): Promise<void> {
  try {
    const workspace = process.cwd();
    const result =
      operation === "inspect"
        ? await inspectLoopDagResources(workspace, dagId)
        : operation === "archive"
          ? archiveLoopDagResources(workspace, dagId)
          : operation === "prune"
            ? await pruneLoopDagResources(workspace, dagId, { dryRun: opts.dryRun, force: opts.force })
            : await promoteLoopDagResult(workspace, dagId, opts.target ?? "fan-in");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopSpeculationListCommand(): Promise<void> {
  try {
    const states = listLoopSpeculationStates(process.cwd());
    console.log(
      states.length === 0
        ? "No persisted Loop speculations."
        : states
            .map((state) => `${state.speculationId}\t${state.status}\t${state.winnerId ?? "-"}\t${state.updatedAt}`)
            .join("\n"),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopSpeculationPromoteCommand(speculationId: string): Promise<void> {
  try {
    console.log(JSON.stringify(await promoteLoopSpeculation(process.cwd(), speculationId), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopSpeculateCommand(
  file: string,
  opts: {
    budget: number;
    tokenBudget?: number;
    maxDurationSeconds?: number;
    maxIterations?: number;
    speculationId?: string;
    resume?: boolean;
    yes?: boolean;
    model?: string;
    profile?: string;
  },
): Promise<void> {
  const workspace = process.cwd();
  const raw = readFileIfExists(resolve(workspace, file), 256 * 1024);
  if (raw === undefined) {
    fail(`Loop speculation file not found: ${file}`);
    process.exitCode = 1;
    return;
  }
  let input: ReturnType<typeof parseLoopSpeculationInput>;
  try {
    input = parseLoopSpeculationInput(JSON.parse(raw) as unknown);
  } catch (error) {
    fail(
      error instanceof SyntaxError
        ? `Loop speculation file is not valid JSON: ${file}`
        : error instanceof Error
          ? error.message
          : String(error),
    );
    process.exitCode = 1;
    return;
  }
  const preflight = await preflightLoop(workspace, opts);
  if (!preflight) return;
  try {
    await withLoopAgentRuntime(
      { config: preflight.config, workspace, model: preflight.model, extractMemory: true },
      async ({ deps, controller }) => {
        const result = await runSpeculativeLoop(deps, {
          workspace,
          task: input.task,
          verifyCommand: input.verifyCommand,
          candidates: input.candidates,
          costBudgetUsd: opts.budget,
          tokenBudget: opts.tokenBudget,
          maxDurationMs:
            opts.maxDurationSeconds === undefined ? undefined : Math.round(opts.maxDurationSeconds * 1_000),
          maxIterations: opts.maxIterations,
          managedWorktrees: true,
          speculationId: opts.speculationId,
          persist: true,
          resume: opts.resume,
          signal: controller.signal,
        });
        console.log(JSON.stringify(result.state ?? result, null, 2));
        if (!result.winner) process.exitCode = 1;
      },
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
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

export async function loopPriorityCommand(loopId: string, priority: number): Promise<void> {
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    if (!workspace) throw new Error(`Persisted loop not found: ${loopId}`);
    const state = setLoopPriority(workspace, loopId, priority);
    console.log(`Updated Loop priority: ${state.loopId}\t${state.priority}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export async function loopPruneCommand(opts: {
  olderThanDays?: number;
  keepLast?: number;
  dryRun?: boolean;
  worktrees?: boolean;
}): Promise<void> {
  try {
    const workspaces = await loopWorkspaces();
    const summaries: string[] = [];
    for (const workspace of workspaces) {
      const preview = pruneLoopStates(workspace, {
        maxAgeDays: opts.olderThanDays ?? 30,
        maxTerminalCount: opts.keepLast ?? 100,
        dryRun: true,
      });
      const candidateIds = new Set(preview.candidates);
      const states = listLoopStates(workspace);
      const removeWholeWorktree =
        opts.worktrees &&
        workspace !== workspaces[0] &&
        states.length > 0 &&
        states.every(
          (state) =>
            candidateIds.has(state.loopId) &&
            state.status === "passed" &&
            state.delivery?.mode === "merge" &&
            state.delivery.phase === "finalized",
        );
      if (removeWholeWorktree) {
        if (opts.dryRun) {
          for (const id of preview.candidates) summaries.push(`would-remove\t${id}\t${workspace}`);
          summaries.push(`would-remove-worktree\t${workspace}`);
        } else {
          try {
            const removed = await cleanupLoopWorktree(process.cwd(), workspace, false, {
              beforeRemove: () => {
                const currentPreview = pruneLoopStates(workspace, {
                  maxAgeDays: opts.olderThanDays ?? 30,
                  maxTerminalCount: opts.keepLast ?? 100,
                  dryRun: true,
                });
                const currentCandidates = new Set(currentPreview.candidates);
                const currentStates = listLoopStates(workspace);
                if (
                  currentStates.length === 0 ||
                  !currentStates.every(
                    (state) =>
                      currentCandidates.has(state.loopId) &&
                      state.status === "passed" &&
                      state.delivery?.mode === "merge" &&
                      state.delivery.phase === "finalized",
                  )
                ) {
                  throw new Error(`Loop worktree retention state changed before cleanup: ${workspace}`);
                }
              },
            });
            for (const id of preview.candidates) summaries.push(`removed\t${id}\t${workspace}`);
            summaries.push(`removed-worktree\t${removed.path}`);
          } catch (error) {
            for (const id of preview.candidates) summaries.push(`skipped\t${id}\t${workspace}`);
            summaries.push(`skipped-worktree\t${workspace}\t${error instanceof Error ? error.message : String(error)}`);
          }
        }
        continue;
      }
      const result = opts.dryRun
        ? preview
        : pruneLoopStates(workspace, {
            maxAgeDays: opts.olderThanDays ?? 30,
            maxTerminalCount: opts.keepLast ?? 100,
          });
      for (const id of opts.dryRun ? result.candidates : result.removed) {
        summaries.push(`${opts.dryRun ? "would-remove" : "removed"}\t${id}\t${workspace}`);
      }
      for (const id of result.skipped) summaries.push(`skipped\t${id}\t${workspace}`);
    }
    console.log(summaries.length > 0 ? summaries.join("\n") : "No eligible Loop records found.");
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
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

export async function loopDeliverCommand(
  loopId: string,
  opts: {
    mode?: LoopDeliveryMode;
    waitCi?: boolean;
    ciRepairs?: number;
    ciRepairBudget?: number;
    yes?: boolean;
    model?: string;
    profile?: string;
  },
): Promise<void> {
  let dispose: (() => void) | undefined;
  let disposeMcp: (() => void) | undefined;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const workspace = await findLoopWorkspace(loopId, false);
    const state = workspace ? loadLoopState(workspace, loopId) : null;
    if (!workspace || !state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    const mode = opts.mode ?? state.delivery?.mode;
    if (!mode) throw new Error("--mode is required when the Loop has no prior delivery attempt");
    const existingCi = state.delivery?.ci;
    const waitCi = opts.waitCi === true || existingCi?.required === true;
    if ((waitCi || opts.ciRepairs !== undefined || opts.ciRepairBudget !== undefined) && mode !== "pr") {
      throw new Error("--wait-ci and CI repair options require --mode pr");
    }
    if (opts.ciRepairs !== undefined && (opts.ciRepairs < 0 || opts.ciRepairs > 3)) {
      throw new Error("--ci-repairs must be between 0 and 3");
    }
    if (opts.ciRepairs !== undefined && !waitCi) throw new Error("--ci-repairs requires --wait-ci");
    if (opts.ciRepairBudget !== undefined && !waitCi) throw new Error("--ci-repair-budget requires --wait-ci");
    if (existingCi && opts.ciRepairs !== undefined && opts.ciRepairs !== existingCi.maxRepairs) {
      throw new Error("CI closure repair count is already frozen for this Loop delivery");
    }
    if (existingCi && opts.ciRepairBudget !== undefined && opts.ciRepairBudget !== existingCi.repairBudgetUsd) {
      throw new Error("CI closure repair budget is already frozen for this Loop delivery");
    }
    const maxRepairs = existingCi?.maxRepairs ?? opts.ciRepairs ?? 0;
    const repairBudgetUsd = existingCi?.repairBudgetUsd ?? opts.ciRepairBudget ?? 1;
    let repairContext: LoopCiRepairContext | undefined;
    const getRepairContext = async (): Promise<LoopCiRepairContext> => {
      if (repairContext) return repairContext;
      const preflight = await preflightLoop(workspace, opts);
      if (!preflight) throw new Error("CI repair prerequisites were not satisfied");
      const mcp = await prepareMcp(preflight.config, workspace);
      disposeMcp = mcp.dispose;
      const created = createCliAgentDeps({
        config: preflight.config,
        workspace,
        pluginContributions: mcp.pluginContributions,
        model: preflight.model,
        mcpToolSpecs: mcp.specs,
        confirm: async () => false,
        extractMemory: false,
        subagents: loadAgentDefinitions(workspace, mcp.pluginContributions),
      });
      dispose = created.dispose;
      repairContext = { deps: created.deps, sandbox: preflight.config.sandbox };
      return repairContext;
    };
    const deliveryOptions: LoopDeliveryOptions = waitCi
      ? {
          ciPolicy: { maxRepairs, repairBudgetUsd },
          beforeFinalize: (delivered, current, updateCi) =>
            closeLoopPrCi({
              workspace,
              delivered,
              state: current,
              getRepairContext,
              maxRepairs,
              repairBudgetUsd,
              signal: controller.signal,
              repairAttempts: current.delivery?.ci?.repairAttempts ?? 0,
              updateCi,
            }),
        }
      : {};
    const delivered = await runLoopDelivery(workspace, loopId, mode, deliveryOptions);
    console.log(delivered.message);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose?.();
    disposeMcp?.();
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
    dagId?: string;
    resume?: boolean;
    maxConcurrency?: number;
    managedWorktrees?: boolean;
    managedWorktreeLimit?: number;
    predictiveBudget?: boolean;
    approve?: string[];
    rerun?: string[];
  },
): Promise<void> {
  const workspace = process.cwd();
  const raw = readFileIfExists(resolve(workspace, file), 512 * 1024);
  if (raw === undefined) {
    fail(`Loop DAG file not found: ${file}`);
    process.exitCode = 1;
    return;
  }
  let parsed: ReturnType<typeof parseLoopDagInput>;
  try {
    parsed = parseLoopDagInput(JSON.parse(raw) as unknown, workspace);
  } catch (error) {
    fail(
      error instanceof SyntaxError
        ? `Loop DAG file is not valid JSON: ${file}`
        : error instanceof Error
          ? error.message
          : String(error),
    );
    process.exitCode = 1;
    return;
  }
  const preflight = await preflightLoop(workspace, opts);
  if (!preflight) return;
  const { nodes, nodeWorkspaces, fanIn } = parsed;
  const { config, model } = preflight;
  try {
    await withLoopAgentRuntime({ config, workspace, model, extractMemory: true }, async ({ deps, controller }) => {
      const approvedNodes = new Set(opts.approve ?? []);
      const results = await runLoopDag(deps, {
        workspace,
        nodes,
        maxConcurrency: opts.maxConcurrency ?? 1,
        ...(opts.managedWorktrees ? { managedWorktrees: true } : {}),
        ...(opts.managedWorktreeLimit !== undefined ? { managedWorktreeLimit: opts.managedWorktreeLimit } : {}),
        ...(opts.predictiveBudget ? { predictiveBudget: true } : {}),
        ...(fanIn ? { fanIn } : {}),
        ...(opts.dagId ? { dagId: opts.dagId } : {}),
        ...(opts.resume ? { resume: true } : {}),
        ...(opts.rerun?.length ? { rerunFrom: opts.rerun } : {}),
        approveNode: (node) => approvedNodes.has(node.id),
        ...(nodeWorkspaces.size > 0 ? { workspaceForNode: (node) => nodeWorkspaces.get(node.id) ?? workspace } : {}),
        ...(opts.budget !== undefined ? { costBudgetUsd: opts.budget } : {}),
        ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
        ...(opts.maxDurationSeconds !== undefined
          ? { maxDurationMs: Math.round(opts.maxDurationSeconds * 1_000) }
          : {}),
        signal: controller.signal,
        onNodeEvent: (nodeId, event) => console.log(`[${nodeId}] ${formatLoopEvent(event)}`),
        onFanIn: (result) =>
          console.log(`[fan-in] ${result.status} · ${result.branch}${result.error ? ` · ${result.error}` : ""}`),
      });
      console.log(
        results
          .map((result) => `${result.id}\t${result.status}${result.reason ? `\t${result.reason}` : ""}`)
          .join("\n"),
      );
      if (results.some((result) => result.status !== "passed")) process.exitCode = 1;
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
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

type PreparedLoopRequest =
  | { kind: "start"; task: string; opts: LoopOptions }
  | { kind: "resume"; loopId: string; opts: LoopResumeOptions; resume: ResumeAutoLoop };

async function executeLoop(request: PreparedLoopRequest, projectPath: string, prepared?: LoopPreflight): Promise<void> {
  const preflight = prepared ?? (await preflightLoop(projectPath, request.opts));
  if (!preflight) return;
  const { config, model } = preflight;
  await runPreparedLoop(request, projectPath, config, model);
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
    fail(t("err.noApiKey"), { hint: t("err.noApiKeyHint2", { keyEnv: apiKeyEnvVar(config.provider) }) });
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
  request: PreparedLoopRequest,
  projectPath: string,
  config: ReturnType<typeof loadConfig>,
  model: string | undefined,
): Promise<void> {
  const { opts } = request;
  // The loop is inherently autonomous: it must apply edits without a human in
  // the loop. We always run in acceptEdits. Without -y we still proceed (that
  // is the sensible default for a "drive to green" command) but print a note.
  if (!opts.yes) console.error(dim(t("cmd.loop.autoApproveNote")));

  try {
    await withLoopAgentRuntime(
      {
        config,
        workspace: projectPath,
        model,
        extractMemory: true,
        forceOnSecondSigint: true,
        onCancel: () => console.error(t("render.cancelling")),
      },
      async ({ deps, controller }) => {
        const common = {
          ...(model ? { model } : {}),
          ...(opts.modelRoutesByFailureCategory
            ? { modelRoutesByFailureCategory: opts.modelRoutesByFailureCategory }
            : {}),
          ...(opts.modelEscalationThreshold !== undefined
            ? { modelEscalationThreshold: opts.modelEscalationThreshold }
            : {}),
          ...(config.planModel ? { planModel: config.planModel } : {}),
          ...(config.escalateOnFailure ? { escalateOnFailure: true } : {}),
          signal: controller.signal,
          onEvent: (event: LoopEvent) => printEvent(event),
        };
        let result: LoopResult;
        if (request.kind === "resume") {
          result = await request.resume(deps, request.loopId, {
            workspace: projectPath,
            ...resumeExtensionOptions(request.opts),
            ...common,
          });
        } else {
          const loopOpts = request.opts;
          let verificationPlan = verificationPlanFromOptions(loopOpts);
          let verifyCommand = loopOpts.verify;
          if (loopOpts.autoVerify) {
            const discovered = discoverLoopVerificationPlan(projectPath);
            verificationPlan = discovered.stages;
            verifyCommand = discovered.stages[0]!.command;
            console.error(
              dim(
                `Discovered verification plan from ${discovered.sources.join(", ")}: ${discovered.stages
                  .map((stage) => stage.id)
                  .join(" → ")}`,
              ),
            );
          }
          result = await runAutoLoop(deps, {
            task: request.task,
            workspace: projectPath,
            verifyCommand: verifyCommand ?? "",
            ...(verificationPlan ? { verificationPlan } : {}),
            ...(loopOpts.stablePasses !== undefined ? { stablePasses: loopOpts.stablePasses } : {}),
            ...(loopOpts.flakyRetries !== undefined ? { flakyRetries: loopOpts.flakyRetries } : {}),
            ...(loopOpts.noProgressRecoveries !== undefined
              ? { maxNoProgressRecoveries: loopOpts.noProgressRecoveries }
              : {}),
            ...(loopOpts.rollbackOnRegression ? { rollbackOnRegression: true } : {}),
            ...(loopOpts.adaptiveBudget ? { adaptiveBudget: true } : {}),
            ...(loopOpts.codeReview ? { codeReview: true } : {}),
            ...(loopOpts.priority !== undefined ? { priority: loopOpts.priority } : {}),
            maxIterations: loopOpts.maxIters ?? 8,
            ...(loopOpts.budget !== undefined ? { costBudgetUsd: loopOpts.budget } : {}),
            ...(loopOpts.tokenBudget !== undefined ? { tokenBudget: loopOpts.tokenBudget } : {}),
            ...(loopOpts.maxDurationSeconds !== undefined
              ? { maxDurationMs: Math.round(loopOpts.maxDurationSeconds * 1_000) }
              : {}),
            ...(loopOpts.maxVerifyRuns !== undefined ? { maxVerifyRuns: loopOpts.maxVerifyRuns } : {}),
            ...(loopOpts.verifyTimeoutSeconds !== undefined
              ? { verifyTimeoutMs: Math.round(loopOpts.verifyTimeoutSeconds * 1_000) }
              : {}),
            ...(loopOpts.agentTimeoutSeconds !== undefined
              ? { agentTimeoutMs: Math.round(loopOpts.agentTimeoutSeconds * 1_000) }
              : {}),
            ...(loopOpts.agentRetries !== undefined ? { maxAgentRetries: loopOpts.agentRetries } : {}),
            approvalMode: "acceptEdits",
            ...(loopOpts.requirements ? { requirementMode: loopOpts.requirements } : {}),
            ...common,
          });
        }
        const exitCode = loopExitCode(result.status);
        if (request.kind === "start" && result.status === "passed" && request.opts.deliver) {
          const loopOpts = request.opts;
          const deliveryMode = request.opts.deliver;
          const deliveryOptions: LoopDeliveryOptions = {};
          if (loopOpts.deliver === "pr" && loopOpts.waitCi) {
            deliveryOptions.ciPolicy = {
              maxRepairs: loopOpts.ciRepairs ?? 0,
              repairBudgetUsd: loopOpts.ciRepairBudget ?? 1,
            };
            deliveryOptions.beforeFinalize = async (delivered, state, updateCi) =>
              closeLoopPrCi({
                workspace: projectPath,
                delivered,
                state,
                getRepairContext: async () => ({
                  deps: { ...deps, extractMemory: false },
                  sandbox: config.sandbox,
                }),
                maxRepairs: loopOpts.ciRepairs ?? 0,
                repairBudgetUsd: loopOpts.ciRepairBudget ?? 1,
                signal: controller.signal,
                repairAttempts: state.delivery?.ci?.repairAttempts ?? 0,
                updateCi,
              });
          }
          const delivered = await runLoopDelivery(projectPath, result.loopId ?? "loop", deliveryMode, deliveryOptions);
          console.log(delivered.message);
        }
        if (exitCode !== undefined) process.exitCode = exitCode;
      },
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export type LoopDeliveryResult = {
  artifact: string;
  message: string;
  branch?: string;
  evidence?: LoopDeliveryEvidence;
};

type LoopDeliveryOptions = {
  ciPolicy?: Pick<LoopDeliveryCiState, "maxRepairs" | "repairBudgetUsd">;
  beforeFinalize?: (
    result: LoopDeliveryResult,
    state: LoopState,
    updateCi: (update: Partial<LoopDeliveryCiState>) => void,
  ) => Promise<LoopDeliveryResult>;
};

export type LoopCiClosureOptions = {
  workspace: string;
  delivered: LoopDeliveryResult;
  state: LoopState;
  getRepairContext: () => Promise<LoopCiRepairContext>;
  maxRepairs: number;
  repairBudgetUsd: number;
  signal: AbortSignal;
  repairAttempts: number;
  updateCi: (update: Partial<LoopDeliveryCiState>) => void;
  ciProvider?: LoopCiProvider;
};

type LoopCiRepairContext = {
  deps: Parameters<typeof runAutoLoop>[0];
  sandbox: ReturnType<typeof loadConfig>["sandbox"];
};

type ExternalCommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };

export function runExternalCommand(
  command: string,
  args: string[],
  workspace: string,
  timeout: number,
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<ExternalCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workspace,
      detached: process.platform !== "win32",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let settled = false;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      killProcessTree(child);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBuffer) {
        stop(new Error(`${command} output exceeded ${maxBuffer} bytes`));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", (error) => stop(error));
    const timer = setTimeout(() => {
      const error = new Error(`${command} timed out after ${timeout}ms`) as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      stop(error);
    }, timeout);
    timer.unref();
    const offAbort = onAbortOnce(signal, () => {
      const error = new Error(`${command} cancelled`) as NodeJS.ErrnoException;
      error.code = "ABORT_ERR";
      stop(error);
    });
    child.once("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      offAbort();
      resolve({
        status,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(failure ? { error: failure } : {}),
      });
    });
  });
}

async function runGh(
  workspace: string,
  args: string[],
  timeout: number,
  signal?: AbortSignal,
  maxBuffer = 1024 * 1024,
): Promise<ExternalCommandResult> {
  const result = await runExternalCommand("gh", args, workspace, timeout, maxBuffer, signal);
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is required");
  }
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ABORT_ERR") throw result.error;
  return result;
}

export async function closeLoopPrCi(options: LoopCiClosureOptions): Promise<LoopDeliveryResult> {
  const url = options.delivered.evidence?.url;
  const branch = options.delivered.evidence?.branch;
  if (!url || !branch) throw new Error("Loop PR delivery lacks CI-check evidence");
  let delivered = options.delivered;
  let repairAttempts = options.repairAttempts;
  const ciProvider =
    options.ciProvider ??
    createGitHubCiProvider((args, timeoutMs, maxBuffer, signal) =>
      runGh(options.workspace, args, timeoutMs, signal, maxBuffer),
    );
  try {
    for (;;) {
      options.signal.throwIfAborted();
      const checks = await ciProvider.waitForRequiredChecks(branch, options.signal);
      if (checks.status === "passed") {
        options.updateCi({ status: "passed", revision: delivered.evidence?.revision, url, error: undefined });
        return delivered;
      }
      if (checks.status === "timed_out") {
        throw new Error(`Timed out waiting for pull request checks after ${PR_CHECKS_TIMEOUT_MS / 60_000} minutes`);
      }
      if (repairAttempts >= options.maxRepairs) {
        throw new Error(`Pull request checks failed after ${repairAttempts} repair attempt(s)`);
      }
      const log = await ciProvider.failedLog(branch, options.signal);
      if (!log) throw new Error("Pull request checks failed and no bounded failed-step log was available");
      const repairContext = await options.getRepairContext();
      repairAttempts++;
      options.updateCi({
        status: "pending",
        repairAttempts,
        revision: delivered.evidence?.revision,
        url,
        error: undefined,
      });
      let injectedCiFailure = false;
      const repaired = await runAutoLoop(repairContext.deps, {
        task: buildCiRepairPrompt(log),
        workspace: options.workspace,
        verifyCommand: options.state.verifyCommand,
        ...(options.state.verificationPlan ? { verificationPlan: options.state.verificationPlan } : {}),
        stablePasses: options.state.stablePasses ?? 1,
        flakyRetries: options.state.flakyRetries ?? 0,
        maxNoProgressRecoveries: 0,
        maxIterations: 2,
        costBudgetUsd: options.repairBudgetUsd,
        approvalMode: "acceptEdits",
        persist: false,
        signal: options.signal,
        verify: async (workspace, command, signal, onOutput) => {
          if (!injectedCiFailure) {
            injectedCiFailure = true;
            onOutput?.("stderr", log);
            return { code: 1, output: log };
          }
          const result = await runShellCommand(command, workspace, options.state.verifyTimeoutMs ?? 120_000, {
            sandbox: repairContext.sandbox,
            workspace,
            signal,
            onOutput,
          });
          return { code: result.exitCode, output: `${result.stdout}${result.stderr}` };
        },
      });
      if (repaired.status !== "passed") {
        throw new Error(`CI repair did not pass local verification: ${repaired.status}`);
      }
      if (!(await isWorktreeDirty(options.workspace))) {
        throw new Error("CI repair produced no repository changes");
      }
      await checkpointWorktree(options.workspace, `fix: repair CI for ${branch}`);
      const revision = gitRevision(options.workspace, branch);
      const pushed = await runExternalCommand(
        "git",
        ["push", "origin", `${revision}:refs/heads/${branch}`],
        options.workspace,
        120_000,
        1024 * 1024,
        options.signal,
      );
      if (pushed.status !== 0 || pushed.error) {
        throw new Error(pushed.stderr.trim() || pushed.error?.message || "Could not publish CI repair");
      }
      options.updateCi({ status: "pending", repairAttempts, revision, url, error: undefined });
      delivered = {
        ...delivered,
        evidence: { ...delivered.evidence, branch, revision, url },
        message: `Pull request checks passed after ${repairAttempts} repair attempt(s): ${url}`,
      };
    }
  } catch (error) {
    const cancelled =
      options.signal.aborted ||
      (error instanceof Error &&
        (error.name === "AbortError" || (error as NodeJS.ErrnoException).code === "ABORT_ERR"));
    options.updateCi({
      status: cancelled ? "pending" : "failed",
      repairAttempts,
      revision: delivered.evidence?.revision,
      url,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 8_192),
    });
    throw error;
  }
}

class LoopDeliveryEvidenceError extends Error {}
class LoopDeliveryVerificationError extends Error {}

async function verifyLoopForDelivery(workspace: string, state: LoopState): Promise<void> {
  const plan = state.verificationPlan ?? [{ id: "verify", command: state.verifyCommand }];
  const stablePasses = state.stablePasses ?? 1;
  const flakyRetries = state.flakyRetries ?? 0;
  const sandbox = loadConfig(workspace).sandbox;
  for (let pass = 1; pass <= stablePasses; pass++) {
    for (const stage of plan) {
      let result: Awaited<ReturnType<typeof runShellCommand>> | undefined;
      try {
        for (let attempt = 0; attempt <= flakyRetries; attempt++) {
          result = await runShellCommand(
            stage.command,
            workspace,
            stage.timeoutMs ?? state.verifyTimeoutMs ?? 120_000,
            {
              sandbox,
              workspace,
            },
          );
          if (result.exitCode === 0) break;
        }
      } catch (error) {
        throw new LoopDeliveryVerificationError(
          `Loop delivery verification could not run stage ${stage.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (result?.exitCode !== 0 && stage.required !== false) {
        const detail = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim().slice(-4_096);
        throw new LoopDeliveryVerificationError(
          `Loop delivery verification failed at stage ${stage.id}${detail ? `: ${detail}` : ""}`,
        );
      }
    }
  }
}

export async function runLoopDelivery(
  projectPath: string,
  loopId: string,
  mode: LoopDeliveryMode,
  options: LoopDeliveryOptions = {},
): Promise<LoopDeliveryResult> {
  let lease: Awaited<ReturnType<typeof acquireLoopLifecycleLeaseWithPreemption>>;
  try {
    lease = await acquireLoopLifecycleLeaseWithPreemption(projectPath, loopId);
  } catch (error) {
    if (isLoopDeliveryActive(projectPath, loopId)) {
      throw new Error(`Loop is still running or delivery is already active: ${loopId}`, { cause: error });
    }
    throw error;
  }
  try {
    if (isLoopLeaseActive(projectPath, loopId)) {
      throw new Error(`Loop is still finalizing and cannot be delivered yet: ${loopId}`);
    }
    const state = loadLoopState(projectPath, loopId);
    if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    if (state.status !== "passed") throw new Error(`Loop delivery requires passed status, found: ${state.status}`);
    if (state.delivery?.mode !== undefined && state.delivery.mode !== mode) {
      throw new Error(`Loop delivery mode is already ${state.delivery.mode}; retry with that mode`);
    }
    const existingCi = state.delivery?.ci;
    if (
      options.ciPolicy &&
      (!Number.isSafeInteger(options.ciPolicy.maxRepairs) ||
        options.ciPolicy.maxRepairs < 0 ||
        options.ciPolicy.maxRepairs > 3 ||
        !Number.isFinite(options.ciPolicy.repairBudgetUsd) ||
        options.ciPolicy.repairBudgetUsd <= 0)
    ) {
      throw new Error("Invalid Loop CI closure policy");
    }
    if ((existingCi || options.ciPolicy) && mode !== "pr") {
      throw new Error("CI closure is only supported for PR delivery");
    }
    if (
      existingCi &&
      options.ciPolicy &&
      (existingCi.maxRepairs !== options.ciPolicy.maxRepairs ||
        existingCi.repairBudgetUsd !== options.ciPolicy.repairBudgetUsd)
    ) {
      throw new Error("CI closure policy is already frozen for this Loop delivery");
    }
    const ci: LoopDeliveryCiState | undefined =
      existingCi ??
      (options.ciPolicy
        ? {
            required: true,
            maxRepairs: options.ciPolicy.maxRepairs,
            repairAttempts: 0,
            repairBudgetUsd: options.ciPolicy.repairBudgetUsd,
            status: "pending",
            updatedAt: new Date().toISOString(),
          }
        : undefined);
    if (ci && ci.status !== "passed" && !options.beforeFinalize) {
      throw new Error("Loop delivery requires CI closure; retry with --wait-ci");
    }
    if (state.delivery?.status === "delivered" && state.delivery.artifact) {
      try {
        if (!hasCompleteLoopDeliveryEvidence(mode, state.delivery.artifact, state.delivery.evidence)) {
          throw new Error("Legacy Loop delivery lacks verifiable evidence");
        }
        const recorded = {
          artifact: state.delivery.artifact,
          branch: state.delivery.evidence?.branch,
          evidence: state.delivery.evidence,
          message: `Loop delivery already complete: ${state.delivery.artifact}`,
        };
        const finalized = await finalizeLoopDelivery(
          projectPath,
          loopId,
          mode,
          state.delivery.artifact,
          () => {},
          recorded,
        );
        return { ...finalized, message: `Loop delivery already complete: ${state.delivery.artifact}` };
      } catch (error) {
        if (error instanceof LoopDeliveryEvidenceError || error instanceof LoopDeliveryVerificationError) throw error;
        // Older versions could persist `delivered` before the side effect. Fall
        // through to a new attempt, which safely repairs or repeats the action.
      }
    }
    const attempts = (state.delivery?.attempts ?? 0) + 1;
    const startedAt = new Date().toISOString();
    const completedAttempt =
      state.delivery?.phase === "action_completed" &&
      state.delivery.artifact &&
      hasCompleteLoopDeliveryEvidence(mode, state.delivery.artifact, state.delivery.evidence)
        ? {
            artifact: state.delivery.artifact,
            evidence: state.delivery.evidence,
            branch: state.delivery.evidence?.branch,
            message: `Finalizing prior Loop delivery: ${state.delivery.artifact}`,
          }
        : undefined;
    saveLoopState(projectPath, {
      ...state,
      delivery: completedAttempt
        ? {
            mode,
            status: "running",
            phase: "action_completed",
            attempts,
            updatedAt: startedAt,
            artifact: completedAttempt.artifact,
            ...(completedAttempt.evidence ? { evidence: completedAttempt.evidence } : {}),
            ...(ci ? { ci } : {}),
          }
        : { mode, status: "running", phase: "prepared", attempts, updatedAt: startedAt, ...(ci ? { ci } : {}) },
      updatedAt: startedAt,
    });
    const updateCi = (update: Partial<LoopDeliveryCiState>): void => {
      const current = loadLoopState(projectPath, loopId);
      const currentCi = current?.delivery?.ci;
      if (!current?.delivery || !currentCi) throw new Error("Loop CI delivery state is unavailable");
      const next: LoopDeliveryCiState = {
        ...currentCi,
        ...update,
        required: true,
        maxRepairs: currentCi.maxRepairs,
        repairBudgetUsd: currentCi.repairBudgetUsd,
        updatedAt: new Date().toISOString(),
      };
      if (update.error === undefined) delete next.error;
      if (update.revision === undefined && "revision" in update) delete next.revision;
      if (update.url === undefined && "url" in update) delete next.url;
      if (next.repairAttempts < 0 || next.repairAttempts > next.maxRepairs) {
        throw new Error("Invalid Loop CI repair progress");
      }
      saveLoopState(projectPath, {
        ...current,
        delivery: { ...current.delivery, ci: next },
        updatedAt: next.updatedAt,
      });
    };
    const persistFailure = (error: unknown): Error => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 8_192) || "delivery failed";
      const failedAt = new Date().toISOString();
      const current = loadLoopState(projectPath, loopId) ?? state;
      const completed = current.delivery?.artifact
        ? {
            phase: "action_completed" as const,
            artifact: current.delivery.artifact,
            ...(current.delivery.evidence ? { evidence: current.delivery.evidence } : {}),
          }
        : { phase: "prepared" as const };
      try {
        saveLoopState(projectPath, {
          ...current,
          delivery: {
            mode,
            status: "failed",
            attempts,
            updatedAt: failedAt,
            error: message,
            ...completed,
            ...(current.delivery?.ci ? { ci: current.delivery.ci } : {}),
          },
          updatedAt: failedAt,
        });
      } catch (persistenceError) {
        return new Error(
          `${message}; could not persist delivery failure: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
        );
      }
      return error instanceof Error ? error : new Error(message);
    };
    const persistActionCompleted = (delivered: LoopDeliveryResult): void => {
      const completedAt = new Date().toISOString();
      const current = loadLoopState(projectPath, loopId) ?? state;
      saveLoopState(projectPath, {
        ...current,
        delivery: {
          mode,
          status: "running",
          phase: "action_completed",
          attempts,
          updatedAt: completedAt,
          artifact: delivered.artifact.slice(0, 8_192),
          ...(delivered.evidence ? { evidence: delivered.evidence } : {}),
          ...(current.delivery?.ci ? { ci: current.delivery.ci } : {}),
        },
        updatedAt: completedAt,
      });
    };
    const persistFinalized = (delivered: LoopDeliveryResult): void => {
      const finalizedAt = new Date().toISOString();
      const current = loadLoopState(projectPath, loopId) ?? state;
      saveLoopState(projectPath, {
        ...current,
        delivery: {
          mode,
          status: "delivered",
          phase: "finalized",
          attempts,
          updatedAt: finalizedAt,
          artifact: delivered.artifact.slice(0, 8_192),
          ...(delivered.evidence ? { evidence: delivered.evidence } : {}),
          ...(current.delivery?.ci ? { ci: current.delivery.ci } : {}),
        },
        updatedAt: finalizedAt,
      });
    };
    let delivered: LoopDeliveryResult;
    try {
      delivered = completedAttempt ?? (await deliverLoop(projectPath, loopId, mode, state));
      if (!completedAttempt) persistActionCompleted(delivered);
      if (options.beforeFinalize) {
        delivered = await options.beforeFinalize(delivered, loadLoopState(projectPath, loopId) ?? state, updateCi);
        persistActionCompleted(delivered);
      }
      const currentCi = loadLoopState(projectPath, loopId)?.delivery?.ci;
      if (currentCi?.required && currentCi.status !== "passed") {
        throw new Error(`Loop delivery CI closure is ${currentCi.status}`);
      }
      delivered = await finalizeLoopDelivery(
        projectPath,
        loopId,
        mode,
        delivered.artifact,
        () => persistFinalized(delivered),
        delivered,
      );
    } catch (error) {
      throw persistFailure(error);
    }
    return delivered;
  } finally {
    lease.release();
  }
}

async function deliverLoop(
  projectPath: string,
  loopId: string,
  mode: LoopDeliveryMode,
  state: LoopState,
): Promise<LoopDeliveryResult> {
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
    return {
      artifact: entry.branch,
      branch: entry.branch,
      evidence: { branch: entry.branch, revision: gitRevision(workspace, entry.branch) },
      message: committed ? `Committed Loop worktree: ${entry.branch}` : `Loop worktree already clean: ${entry.branch}`,
    };
  }
  if (mode === "merge") {
    await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
    return {
      artifact: entry.branch,
      branch: entry.branch,
      evidence: { branch: entry.branch, revision: gitRevision(workspace, entry.branch) },
      message: `Prepared Loop worktree branch for merge: ${entry.branch}`,
    };
  }
  if (mode === "pr") {
    await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
    await verifyLoopForDelivery(workspace, state);
    if (await isWorktreeDirty(workspace)) {
      throw new LoopDeliveryVerificationError("Loop delivery verification modified the worktree");
    }
    const verifiedRevision = gitRevision(workspace, entry.branch);
    const base = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repository.basePath,
      encoding: "utf8",
    });
    if (base.status !== 0 || !base.stdout.trim())
      throw new Error(base.stderr.trim() || "Could not resolve base branch");
    const pushed = spawnSync("git", ["push", "origin", `${verifiedRevision}:refs/heads/${entry.branch}`], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (pushed.status !== 0) throw new Error(pushed.stderr.trim() || "Could not push Loop worktree branch");
    const existing = spawnSync("gh", ["pr", "view", entry.branch, "--json", "url", "--jq", ".url"], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (existing.error && (existing.error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("GitHub CLI (gh) is required");
    }
    const existingUrl = existing.status === 0 ? existing.stdout.trim() : "";
    if (existingUrl) {
      return {
        artifact: existingUrl,
        branch: entry.branch,
        evidence: { branch: entry.branch, revision: verifiedRevision, url: existingUrl },
        message: `Using existing pull request: ${existingUrl}`,
      };
    }
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
    const url = pr.stdout.trim();
    if (!url) throw new Error("GitHub CLI did not return a pull request URL");
    return {
      artifact: url,
      branch: entry.branch,
      evidence: { branch: entry.branch, revision: verifiedRevision, url },
      message: `Created draft pull request: ${url}`,
    };
  }
  const target = join(workspace, ".seekforge", "loops", `${loopId}.patch`);
  try {
    if (!lstatSync(target).isFile()) throw new Error(`Unsafe Loop patch path: ${target}`);
    rmSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await checkpointWorktree(workspace, `feat: deliver ${loopId}`);
  const patch = await createWorktreePatch(repository.basePath, entry.branch);
  if (!patch) throw new Error("Loop worktree has no changes to deliver");
  mkdirSync(dirname(target), { recursive: true });
  writeLoopPatch(target, patch);
  return {
    artifact: target,
    evidence: { branch: entry.branch, revision: gitRevision(workspace, entry.branch), sha256: sha256(patch) },
    message: `Wrote Loop patch: ${target}`,
  };
}

async function finalizeLoopDelivery(
  projectPath: string,
  loopId: string,
  mode: LoopDeliveryMode,
  artifact: string,
  persistFinalized: () => void,
  result?: LoopDeliveryResult,
): Promise<LoopDeliveryResult> {
  const repository = await resolveLoopRepository(projectPath);
  const workspace = resolve(projectPath);
  const entry = (await listGitWorktrees(repository.basePath)).find(
    (candidate) => resolve(candidate.path) === workspace,
  );
  if (!entry?.branch.startsWith("seekforge/loop-"))
    throw new Error("Current workspace is not a retained Loop worktree");
  if ((mode === "checkpoint" || mode === "merge") && artifact !== entry.branch) {
    throw new LoopDeliveryEvidenceError(`Loop delivery artifact does not match retained branch: ${artifact}`);
  }
  if (result?.evidence?.branch && result.evidence.branch !== entry.branch) {
    throw new LoopDeliveryEvidenceError(
      `Loop delivery evidence does not match retained branch: ${result.evidence.branch}`,
    );
  }
  if (result?.evidence?.revision && !gitRevisionIsAncestor(workspace, result.evidence.revision, entry.branch)) {
    throw new LoopDeliveryEvidenceError(
      `Loop delivery revision no longer matches retained branch: ${result.evidence.revision}`,
    );
  }
  if (result?.evidence?.revision) {
    const statePath = `.seekforge/loops/${loopId}.json`;
    const allowedPaths = new Set([statePath, ...(mode === "patch" ? [`.seekforge/loops/${loopId}.patch`] : [])]);
    const unexpected = (await worktreeChangedPathsSince(workspace, result.evidence.revision, entry.branch)).filter(
      (path) => !allowedPaths.has(path),
    );
    if (unexpected.length > 0) {
      throw new LoopDeliveryEvidenceError(`Loop delivery branch contains unverified changes: ${unexpected.join(", ")}`);
    }
  }
  if (mode === "patch" && result?.evidence?.sha256) {
    const patch = readFileIfExists(artifact, 16 * 1024 * 1024);
    if (patch === undefined || sha256(patch) !== result.evidence.sha256) {
      throw new Error(`Loop patch evidence does not match artifact: ${artifact}`);
    }
  }
  if (mode === "pr" && result?.evidence?.url && result.evidence.url !== artifact) {
    throw new Error(`Loop pull request evidence does not match artifact: ${artifact}`);
  }
  const verificationState = loadLoopState(workspace, loopId);
  if (!verificationState) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
  await verifyLoopForDelivery(workspace, verificationState);
  if (result?.evidence?.revision) {
    const statePath = `.seekforge/loops/${loopId}.json`;
    const allowedPaths = new Set([statePath, ...(mode === "patch" ? [`.seekforge/loops/${loopId}.patch`] : [])]);
    const unexpected = (await worktreeChangedPathsSince(workspace, result.evidence.revision, entry.branch)).filter(
      (path) => !allowedPaths.has(path),
    );
    if (unexpected.length > 0) {
      throw new LoopDeliveryEvidenceError(
        `Loop delivery verification left unpublishable changes: ${unexpected.join(", ")}`,
      );
    }
  }
  persistFinalized();

  if (mode === "checkpoint" || mode === "merge" || mode === "pr") {
    await checkpointWorktreePaths(workspace, [`.seekforge/loops/${loopId}.json`], `chore: record ${loopId} delivery`);
  } else {
    const target = join(workspace, ".seekforge", "loops", `${loopId}.patch`);
    if (artifact !== target || !existsSync(target) || !lstatSync(target).isFile()) {
      throw new Error(`Loop patch artifact is missing or invalid: ${target}`);
    }
    await checkpointWorktreePaths(workspace, [`.seekforge/loops/${loopId}.json`], `chore: record ${loopId} delivery`);
  }
  if (result?.evidence?.revision) {
    const statePath = `.seekforge/loops/${loopId}.json`;
    const allowedPaths = new Set([statePath, ...(mode === "patch" ? [`.seekforge/loops/${loopId}.patch`] : [])]);
    const unexpected = (await worktreeChangedPathsSince(workspace, result.evidence.revision, entry.branch)).filter(
      (path) => !allowedPaths.has(path),
    );
    if (unexpected.length > 0) {
      throw new LoopDeliveryEvidenceError(`Loop delivery publication scope changed: ${unexpected.join(", ")}`);
    }
  }
  const publishRevision = gitRevision(workspace, entry.branch);
  if (mode === "merge") {
    const merged = await mergeWorktree(repository.basePath, workspace, entry.branch, { revision: publishRevision });
    if ("conflict" in merged) throw new Error(`Loop delivery merge conflicted: ${merged.files.join(", ")}`);
  } else if (mode === "pr") {
    const pushed = spawnSync("git", ["push", "origin", `${publishRevision}:refs/heads/${entry.branch}`], {
      cwd: workspace,
      encoding: "utf8",
    });
    if (pushed.status !== 0) throw new Error(pushed.stderr.trim() || "Could not publish final delivery state");
  }
  return result ?? { artifact, branch: entry.branch, message: `Loop delivery complete: ${artifact}` };
}

function gitRevision(workspace: string, ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", ref], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error(result.stderr.trim() || `Could not resolve ${ref}`);
  return result.stdout.trim();
}

function gitRevisionIsAncestor(workspace: string, revision: string, ref: string): boolean {
  if (!/^[0-9a-fA-F]{40,64}$/.test(revision)) return false;
  const result = spawnSync("git", ["merge-base", "--is-ancestor", revision, ref], {
    cwd: workspace,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return result.status === 0;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function writeLoopPatch(target: string, patch: string): void {
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, patch, "utf8");
    closeSync(fd);
    renameSync(temp, target);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The write path already closed the descriptor.
    }
    rmSync(temp, { force: true });
    throw error;
  }
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
