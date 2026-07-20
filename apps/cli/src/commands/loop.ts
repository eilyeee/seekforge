import {
  MAX_LOOP_ITERATIONS,
  WorktreeGitError,
  listLoopStates,
  loadLoopState,
  loadAgentDefinitions,
  removeLoopState,
  resumeAutoLoop,
  runAutoLoop,
  type LoopEvent,
  type LoopResult,
  type LoopRequirementMode,
} from "@seekforge/core";
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

export type LoopResumeOptions = Omit<LoopOptions, "verify" | "worktree" | "maxIters" | "budget"> & {
  addIters?: number;
  addBudget?: number;
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
} {
  return {
    ...(opts.addIters !== undefined ? { additionalIterations: opts.addIters } : {}),
    ...(opts.addBudget !== undefined ? { additionalCostBudgetUsd: opts.addBudget } : {}),
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
    model,
    mcpToolSpecs: mcp.specs,
    confirm: async () => false,
    extractMemory: true,
    subagents: loadAgentDefinitions(projectPath),
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
          maxIterations: (opts as LoopOptions).maxIters ?? 8,
          ...((opts as LoopOptions).budget !== undefined ? { costBudgetUsd: (opts as LoopOptions).budget } : {}),
          approvalMode: "acceptEdits",
          ...((opts as LoopOptions).requirements ? { requirementMode: (opts as LoopOptions).requirements } : {}),
          ...common,
        });
    // Distinct exit code: requirements_pending is a deliberate pause awaiting
    // approval, not a failure — scripts resume with --approve-requirements
    // rather than treating it like an exhausted/failed loop.
    if (result.status === "requirements_pending") process.exitCode = 2;
    else if (result.status !== "passed") process.exitCode = 1;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    dispose();
    mcp.dispose();
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
