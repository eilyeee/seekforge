import { type Command, InvalidArgumentError } from "commander";
import {
  loopCleanupCommand,
  loopControlCommand,
  loopCommand,
  loopDeleteCommand,
  loopDiagnoseCommand,
  loopDeliverCommand,
  loopEvidenceCommand,
  loopDagCommand,
  loopDagResourcesCommand,
  loopListCommand,
  loopHistoryCommand,
  loopIntelligenceCommand,
  loopRecoverCommand,
  loopPriorityCommand,
  loopPruneCommand,
  loopResumeCommand,
  loopShowCommand,
  loopSpeculateCommand,
  loopSpeculationListCommand,
  loopSpeculationPromoteCommand,
} from "./commands/loop.js";
import { isLoopFailureCategory, type LoopFailureCategory } from "@seekforge/core";

type LoopCommandRegistration = {
  collect: (value: string, previous: string[]) => string[];
  parsePositiveInt: (value: string) => number;
  parseNonNegativeInt: (value: string) => number;
  parsePositiveFloat: (value: string) => number;
  rootProfile: () => string | undefined;
};

function parseLoopPriority(val: string): number {
  if (!/^-?[0-9]+$/.test(val)) throw new InvalidArgumentError("must be an integer from -10 to 10");
  const priority = Number(val);
  if (!Number.isSafeInteger(priority) || priority < -10 || priority > 10) {
    throw new InvalidArgumentError("must be an integer from -10 to 10");
  }
  return priority;
}

function parseRequirementMode(val: string): "quick" | "analyze" | "confirm" {
  if (val !== "quick" && val !== "analyze" && val !== "confirm") {
    throw new InvalidArgumentError('must be "quick", "analyze", or "confirm"');
  }
  return val;
}

function parseLoopDelivery(val: string): "checkpoint" | "merge" | "patch" | "pr" {
  if (val !== "checkpoint" && val !== "merge" && val !== "patch" && val !== "pr") {
    throw new InvalidArgumentError('must be "checkpoint", "merge", "patch", or "pr"');
  }
  return val;
}

function parseModelEscalationThreshold(val: string): number {
  if (!/^[1-8]$/.test(val)) throw new InvalidArgumentError("must be an integer from 1 to 8");
  return Number(val);
}

export function parseLoopModelRoutes(values: readonly string[]): Partial<Record<LoopFailureCategory, string[]>> {
  const routes: Partial<Record<LoopFailureCategory, string[]>> = {};
  for (const value of values) {
    const separator = value.indexOf("=");
    const category = separator < 0 ? "" : value.slice(0, separator);
    const models = separator < 0 ? [] : value.slice(separator + 1).split(",");
    if (
      !isLoopFailureCategory(category) ||
      models.length === 0 ||
      models.length > 8 ||
      new Set(models).size !== models.length ||
      models.some(
        (model) =>
          !model ||
          model !== model.trim() ||
          model.length > 256 ||
          model.includes("=") ||
          /[\u0000-\u001f]/.test(model),
      ) ||
      routes[category as LoopFailureCategory] !== undefined
    ) {
      throw new InvalidArgumentError("model route must be a unique category=model[,model...] chain");
    }
    routes[category as LoopFailureCategory] = models;
  }
  return routes;
}

export function registerLoopCommands(program: Command, registration: LoopCommandRegistration): void {
  const { collect, parsePositiveInt, parseNonNegativeInt, parsePositiveFloat, rootProfile } = registration;
  program
    .command("loop")
    .argument("<task>", "task to drive to green (the verify command's exit 0)")
    .option("--verify <cmd>", "success criterion: shell command whose exit 0 means done")
    .option("--auto-verify", "discover and freeze a verification pipeline from project manifests")
    .option(
      "--verify-stage <id[@path,...]=command>",
      "append a stage, optionally selected by changed path prefixes",
      collect,
      [],
    )
    .option("--stable-passes <n>", "required consecutive full-pipeline passes (1-5)", parsePositiveInt)
    .option("--flaky-retries <n>", "reruns of a failed verifier stage before editing (0-5)", parseNonNegativeInt)
    .option("--stuck-recoveries <n>", "strategy resets before no_progress (0-5)", parseNonNegativeInt)
    .option("--rollback-regressions", "rollback iterations that increase failures (isolated worktree only)")
    .option("--adaptive-budget", "stop before an iteration predicted to exceed a hard budget")
    .option("--code-review", "require a fresh independent final-diff review before success")
    .option("--priority <n>", "automatic recovery priority from -10 to 10", parseLoopPriority)
    .option(
      "--deliver <mode>",
      "after passing: checkpoint, merge, patch, or draft PR (worktree only)",
      parseLoopDelivery,
    )
    .option("--wait-ci", "for PR delivery, wait for required checks")
    .option("--ci-repairs <n>", "bounded CI-log repair attempts after PR delivery (0-3)", parseNonNegativeInt, 0)
    .option("--ci-repair-budget <usd>", "cost cap for each CI repair attempt", parsePositiveFloat, 1)
    .option("--max-iters <n>", "max run iterations before giving up (default 8)", parsePositiveInt)
    .option("--budget <usd>", "cumulative cost cap in USD across iterations", parsePositiveFloat)
    .option("--token-budget <n>", "cumulative prompt + completion token cap", parsePositiveInt)
    .option("--max-duration <seconds>", "total wall-clock budget in seconds", parsePositiveFloat)
    .option("--max-verifies <n>", "maximum verifier executions including the pre-check", parsePositiveInt)
    .option("--verify-timeout <seconds>", "timeout for one verifier execution", parsePositiveFloat)
    .option("--agent-timeout <seconds>", "timeout for one agent attempt", parsePositiveFloat)
    .option("--agent-retries <n>", "retries for transient agent failures (default 1)", parseNonNegativeInt)
    .option("--requirements <mode>", "requirement gate: quick, analyze, or confirm", parseRequirementMode, "quick")
    .option("-y, --yes", "run autonomously (acceptEdits) without the auto-approve note")
    .option("-m, --model <model>", "override model")
    .option("--model-route <category=models>", "route and escalate edits through comma-separated models", collect, [])
    .option(
      "--model-escalation-threshold <n>",
      "same-category failures per routed model (1-8)",
      parseModelEscalationThreshold,
    )
    .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
    .option("--worktree [name]", "run in a retained isolated worktree (optional name)")
    .description("autonomously run → verify → continue until the verify command passes")
    .action(
      async (
        task: string,
        opts: {
          verify?: string;
          autoVerify?: boolean;
          maxIters?: number;
          budget?: number;
          tokenBudget?: number;
          maxDuration?: number;
          maxVerifies?: number;
          verifyTimeout?: number;
          agentTimeout?: number;
          agentRetries?: number;
          verifyStage?: string[];
          stablePasses?: number;
          flakyRetries?: number;
          stuckRecoveries?: number;
          rollbackRegressions?: boolean;
          codeReview?: boolean;
          priority?: number;
          deliver?: "checkpoint" | "merge" | "patch" | "pr";
          waitCi?: boolean;
          ciRepairs?: number;
          ciRepairBudget?: number;
          yes?: boolean;
          model?: string;
          modelRoute?: string[];
          modelEscalationThreshold?: number;
          profile?: string;
          worktree?: boolean | string;
          requirements: "quick" | "analyze" | "confirm";
        },
      ) => {
        await loopCommand(task, {
          verify: opts.verify,
          autoVerify: opts.autoVerify,
          maxIters: opts.maxIters,
          budget: opts.budget,
          tokenBudget: opts.tokenBudget,
          maxDurationSeconds: opts.maxDuration,
          maxVerifyRuns: opts.maxVerifies,
          verifyTimeoutSeconds: opts.verifyTimeout,
          agentTimeoutSeconds: opts.agentTimeout,
          agentRetries: opts.agentRetries,
          verifyStages: opts.verifyStage,
          stablePasses: opts.stablePasses,
          flakyRetries: opts.flakyRetries,
          noProgressRecoveries: opts.stuckRecoveries,
          rollbackOnRegression: opts.rollbackRegressions,
          codeReview: opts.codeReview,
          priority: opts.priority,
          deliver: opts.deliver,
          waitCi: opts.waitCi,
          ciRepairs: opts.ciRepairs,
          ciRepairBudget: opts.ciRepairBudget,
          yes: opts.yes,
          model: opts.model,
          modelRoutesByFailureCategory:
            opts.modelRoute && opts.modelRoute.length > 0 ? parseLoopModelRoutes(opts.modelRoute) : undefined,
          modelEscalationThreshold: opts.modelEscalationThreshold,
          profile: opts.profile ?? rootProfile(),
          worktree: opts.worktree,
          requirements: opts.requirements,
        });
      },
    );

  program
    .command("loop-dag")
    .argument("<file>", "JSON DAG with nodes: id, task, verifyCommand, and optional dependsOn")
    .option("--budget <usd>", "shared cumulative cost cap in USD", parsePositiveFloat)
    .option("--token-budget <n>", "shared prompt + completion token cap", parsePositiveInt)
    .option("--max-duration <seconds>", "shared wall-clock budget in seconds", parsePositiveFloat)
    .option("--dag-id <id>", "stable checkpoint id (defaults to a graph fingerprint)")
    .option("--resume", "resume completed nodes from the durable DAG checkpoint")
    .option("--rerun <node-id>", "on resume, invalidate this node and all downstream nodes", collect, [])
    .option("--approve <node-id>", "approve a requiresApproval node for this run", collect, [])
    .option("--max-concurrency <n>", "parallel nodes (2-8 require distinct node workspace fields)", parsePositiveInt, 1)
    .option("--managed-worktrees", "automatically create and retain one isolated Git worktree per node")
    .option("--worktree-limit <n>", "maximum managed seekforge worktrees in the repository", parsePositiveInt)
    .option("--predictive-budget", "weight scheduling from bounded historical cost and duration")
    .option("-y, --yes", "authorize the workspace without prompting")
    .option("-m, --model <model>", "override model")
    .option("--profile <name>", "use a named config profile")
    .description("run a dependency graph of Loop tasks sequentially with shared budgets")
    .action(
      async (
        file: string,
        opts: {
          budget?: number;
          tokenBudget?: number;
          maxDuration?: number;
          yes?: boolean;
          model?: string;
          profile?: string;
          dagId?: string;
          resume?: boolean;
          maxConcurrency?: number;
          managedWorktrees?: boolean;
          worktreeLimit?: number;
          predictiveBudget?: boolean;
          rerun?: string[];
          approve?: string[];
        },
      ) => {
        await loopDagCommand(file, {
          budget: opts.budget,
          tokenBudget: opts.tokenBudget,
          maxDurationSeconds: opts.maxDuration,
          yes: opts.yes,
          model: opts.model,
          profile: opts.profile ?? rootProfile(),
          dagId: opts.dagId,
          resume: opts.resume,
          maxConcurrency: opts.maxConcurrency,
          managedWorktrees: opts.managedWorktrees,
          managedWorktreeLimit: opts.worktreeLimit,
          predictiveBudget: opts.predictiveBudget,
          rerun: opts.rerun,
          approve: opts.approve,
        });
      },
    );

  program
    .command("loop-resume")
    .argument("<loop-id>", "persisted loop id to continue")
    .option("-y, --yes", "continue autonomously without the auto-approve note")
    .option("-m, --model <model>", "override model")
    .option("--model-route <category=models>", "route and escalate edits through comma-separated models", collect, [])
    .option(
      "--model-escalation-threshold <n>",
      "same-category failures per routed model (1-8)",
      parseModelEscalationThreshold,
    )
    .option("--add-iters <n>", "add iterations to the persisted loop limit", parsePositiveInt)
    .option("--add-budget <usd>", "add USD to the persisted cost budget", parsePositiveFloat)
    .option("--add-tokens <n>", "add tokens to the persisted token budget", parsePositiveInt)
    .option("--add-duration <seconds>", "add wall-clock seconds to the persisted duration budget", parsePositiveFloat)
    .option("--add-verifies <n>", "add verifier executions to the persisted limit", parsePositiveInt)
    .option("--approve-requirements", "approve a persisted confirm-mode requirement specification")
    .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
    .description("resume a persisted autonomous loop with its remaining limits and verification state")
    .action(
      async (
        loopId: string,
        opts: {
          yes?: boolean;
          model?: string;
          modelRoute?: string[];
          modelEscalationThreshold?: number;
          addIters?: number;
          addBudget?: number;
          addTokens?: number;
          addDuration?: number;
          addVerifies?: number;
          approveRequirements?: boolean;
          profile?: string;
        },
      ) => {
        await loopResumeCommand(loopId, {
          yes: opts.yes,
          model: opts.model,
          modelRoutesByFailureCategory:
            opts.modelRoute && opts.modelRoute.length > 0 ? parseLoopModelRoutes(opts.modelRoute) : undefined,
          modelEscalationThreshold: opts.modelEscalationThreshold,
          addIters: opts.addIters,
          addBudget: opts.addBudget,
          addTokens: opts.addTokens,
          addDurationSeconds: opts.addDuration,
          addVerifyRuns: opts.addVerifies,
          approveRequirements: opts.approveRequirements,
          profile: opts.profile ?? rootProfile(),
        });
      },
    );

  program
    .command("loop-list")
    .description("list persisted loops in the base checkout and retained loop worktrees")
    .action(loopListCommand);
  program.command("loop-show").argument("<loop-id>").description("show a persisted loop").action(loopShowCommand);
  program
    .command("loop-diagnose")
    .argument("<loop-id>")
    .description("check a Loop checkpoint against its retained event history")
    .action(loopDiagnoseCommand);
  program
    .command("loop-intelligence")
    .description("show bounded cross-run verification reliability and anomaly findings")
    .action(loopIntelligenceCommand);
  program
    .command("loop-history")
    .argument("<loop-id>")
    .option("--after <seq>", "return events after this sequence", parseNonNegativeInt)
    .option("--limit <n>", "maximum events (1-2000)", parsePositiveInt)
    .description("replay persisted Loop events as JSONL")
    .action((loopId: string, opts: { after?: number; limit?: number }) => loopHistoryCommand(loopId, opts));
  program
    .command("loop-evidence")
    .argument("<loop-id>")
    .option("--format <format>", "json, sarif, or junit", "json")
    .option("--compare <loop-id>", "compare with another persisted Loop")
    .description("export or compare requirement, verification, iteration, and delivery evidence")
    .action((loopId: string, opts: { format: string; compare?: string }) => {
      if (opts.format !== "json" && opts.format !== "sarif" && opts.format !== "junit") {
        throw new InvalidArgumentError("format must be json, sarif, or junit");
      }
      return loopEvidenceCommand(loopId, { format: opts.format, compare: opts.compare });
    });
  program
    .command("loop-dag-resources")
    .argument("<dag-id>")
    .argument("<operation>", "inspect, archive, prune, or promote")
    .option("--dry-run", "preview pruning")
    .option("--force", "prune without an archive marker")
    .option("--target <node-id>", "node id or fan-in for promotion", "fan-in")
    .description("inspect or manage retained Loop DAG worktrees")
    .action((dagId: string, operation: string, opts: { dryRun?: boolean; force?: boolean; target?: string }) => {
      if (!(["inspect", "archive", "prune", "promote"] as const).includes(operation as never)) {
        throw new InvalidArgumentError("operation must be inspect, archive, prune, or promote");
      }
      return loopDagResourcesCommand(dagId, operation as "inspect" | "archive" | "prune" | "promote", opts);
    });
  program
    .command("loop-speculate")
    .argument("<file>", "JSON with task, verifyCommand, and 2-3 candidate strategies")
    .requiredOption("--budget <usd>", "shared positive cost cap", parsePositiveFloat)
    .option("--token-budget <n>", "shared token cap", parsePositiveInt)
    .option("--max-duration <seconds>", "shared wall-clock budget", parsePositiveFloat)
    .option("--max-iters <n>", "iterations per candidate", parsePositiveInt)
    .option("--speculation-id <id>", "stable persisted speculation id")
    .option("--resume", "resume a persisted speculation")
    .option("-y, --yes", "authorize the workspace without prompting")
    .option("-m, --model <model>", "override model")
    .option("--profile <name>", "use a named config profile")
    .description("run 2-3 isolated candidate repair strategies and rank passing results")
    .action(
      (
        file: string,
        opts: {
          budget: number;
          tokenBudget?: number;
          maxDuration?: number;
          maxIters?: number;
          speculationId?: string;
          resume?: boolean;
          yes?: boolean;
          model?: string;
          profile?: string;
        },
      ) =>
        loopSpeculateCommand(file, {
          budget: opts.budget,
          tokenBudget: opts.tokenBudget,
          maxDurationSeconds: opts.maxDuration,
          maxIterations: opts.maxIters,
          speculationId: opts.speculationId,
          resume: opts.resume,
          yes: opts.yes,
          model: opts.model,
          profile: opts.profile ?? rootProfile(),
        }),
    );
  program
    .command("loop-speculation-list")
    .description("list persisted Loop speculations")
    .action(loopSpeculationListCommand);
  program
    .command("loop-speculation-promote")
    .argument("<speculation-id>")
    .description("merge the winning speculative worktree into the current branch")
    .action(loopSpeculationPromoteCommand);
  program
    .command("loop-recover")
    .description("mark orphaned running loops as interrupted and resumable")
    .action(loopRecoverCommand);
  program
    .command("loop-priority")
    .argument("<loop-id>")
    .argument("<priority>", "integer from -10 to 10", parseLoopPriority)
    .description("set automatic recovery priority for a persisted Loop")
    .action(loopPriorityCommand);
  program
    .command("loop-prune")
    .option("--older-than-days <days>", "remove terminal records at least this old (default 30)", parseNonNegativeInt)
    .option(
      "--keep-last <n>",
      "retain at least the newest N eligible terminal records (default 100)",
      parseNonNegativeInt,
    )
    .option("--worktrees", "also remove clean, finalized merge worktrees when all their records are pruned")
    .option("--dry-run", "show eligible records without removing them")
    .description("prune old terminal Loop records and their bounded histories")
    .action((opts: { olderThanDays?: number; keepLast?: number; worktrees?: boolean; dryRun?: boolean }) =>
      loopPruneCommand(opts),
    );
  program
    .command("loop-pause")
    .argument("<loop-id>")
    .description("pause an active Loop at its next safe boundary")
    .action((loopId: string) => loopControlCommand(loopId, { operation: "pause" }));
  program
    .command("loop-continue")
    .argument("<loop-id>")
    .description("continue a paused active Loop")
    .action((loopId: string) => loopControlCommand(loopId, { operation: "resume" }));
  program
    .command("loop-steer")
    .argument("<loop-id>")
    .argument("<message>")
    .description("queue guidance for an active Loop at its next safe boundary")
    .action((loopId: string, message: string) => loopControlCommand(loopId, { operation: "steer", message }));
  program
    .command("loop-deliver")
    .argument("<loop-id>")
    .option("--mode <mode>", "checkpoint | merge | patch | pr", parseLoopDelivery)
    .option("--wait-ci", "wait for required PR checks, including on a resumed delivery")
    .option("--ci-repairs <n>", "bounded CI-log repair attempts (0-3)", parseNonNegativeInt)
    .option("--ci-repair-budget <usd>", "cost cap for each CI repair attempt", parsePositiveFloat)
    .option("-y, --yes", "authorize autonomous CI repair in this workspace")
    .option("-m, --model <model>", "override model used for CI repair")
    .option("--profile <name>", "use a named config profile for CI repair")
    .description("deliver or retry delivery for a passed Loop")
    .action(loopDeliverCommand);
  program
    .command("loop-delete")
    .argument("<loop-id>")
    .description("delete a persisted loop record")
    .action(loopDeleteCommand);
  program
    .command("loop-cleanup")
    .argument("<name>", "retained loop worktree name, branch, or path")
    .option("--force", "remove a dirty inactive worktree and discard its changes")
    .description("remove a retained loop worktree")
    .action((name: string, opts: { force?: boolean }) => loopCleanupCommand(name, opts));
}
