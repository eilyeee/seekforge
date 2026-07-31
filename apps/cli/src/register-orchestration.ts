import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  orchestrationPolicyCommand,
  orchestrationIndexCommand,
  orchestrationProposalsCommand,
  orchestrationReportCommand,
  orchestrationRolloutCommand,
  orchestrationMaintenanceCommand,
} from "./commands/orchestration.js";

function positiveNumber(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new InvalidArgumentError("value must be a positive number");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError("value must be a positive number");
  return parsed;
}

function rate(value: string): number {
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)) {
    throw new InvalidArgumentError("value must be from 0 to 1");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("value must be from 0 to 1");
  }
  return parsed;
}

function boundedInteger(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new InvalidArgumentError("value must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) throw new InvalidArgumentError("value is out of range");
  return parsed;
}

function resultLimit(value: string): number {
  const parsed = boundedInteger(value);
  if (parsed < 1 || parsed > 100) throw new InvalidArgumentError("value must be an integer from 1 to 100");
  return parsed;
}

function evaluationWindow(value: string): number {
  const parsed = boundedInteger(value);
  if (parsed < 1 || parsed > 1_000) throw new InvalidArgumentError("value must be an integer from 1 to 1000");
  return parsed;
}

function rolloutSamples(value: string): number {
  const parsed = boundedInteger(value);
  if (parsed < 1 || parsed > 32) throw new InvalidArgumentError("value must be an integer from 1 to 32");
  return parsed;
}

export function registerOrchestrationCommands(program: Command): void {
  const orchestration = program
    .command("orchestration")
    .description("inspect and explicitly review cross-Loop and Graph decision intelligence");
  orchestration
    .command("report")
    .option("--max-p95-ms <ms>", "SLO maximum P95 duration", positiveNumber)
    .option("--max-cost <usd>", "SLO maximum cost", positiveNumber)
    .option("--max-failure-rate <rate>", "SLO maximum failure rate", rate)
    .option("--min-coverage <rate>", "SLO minimum forecast coverage", rate)
    .option("--loop-offset <n>", "Loop result offset", boundedInteger)
    .option("--graph-offset <n>", "Graph result offset", boundedInteger)
    .option("--limit <n>", "results per orchestration kind, 1-100", resultLimit)
    .action(
      (options: {
        maxP95Ms?: number;
        maxCost?: number;
        maxFailureRate?: number;
        minCoverage?: number;
        loopOffset?: number;
        graphOffset?: number;
        limit?: number;
      }) =>
        orchestrationReportCommand(
          {
            ...(options.maxP95Ms === undefined ? {} : { maxP95DurationMs: options.maxP95Ms }),
            ...(options.maxCost === undefined ? {} : { maxCostUsd: options.maxCost }),
            ...(options.maxFailureRate === undefined ? {} : { maxFailureRate: options.maxFailureRate }),
            ...(options.minCoverage === undefined ? {} : { minForecastCoverage: options.minCoverage }),
          },
          { loopOffset: options.loopOffset, graphOffset: options.graphOffset, limit: options.limit },
        ),
    );
  orchestration
    .command("proposals")
    .argument("<operation>", "list, refresh, approve, dismiss, apply, rollback, or observe")
    .argument("[id]", "proposal id for review, apply, or rollback")
    .option("--expected-updated-at <iso>", "reject review when the retained proposal version changed")
    .option("--auto-rollback", "roll back applied deployments whose observed metrics regress")
    .action(
      (operation: string, id: string | undefined, options: { expectedUpdatedAt?: string; autoRollback?: boolean }) => {
        if (
          !(["list", "refresh", "approve", "dismiss", "apply", "rollback", "observe"] as const).includes(
            operation as never,
          )
        ) {
          throw new InvalidArgumentError("invalid proposal operation");
        }
        if (["list", "refresh", "observe"].includes(operation) && id !== undefined) {
          throw new InvalidArgumentError(`${operation} does not accept a proposal id`);
        }
        if (operation !== "observe" && options.autoRollback === true) {
          throw new InvalidArgumentError("--auto-rollback is valid only for observe");
        }
        if (!["approve", "dismiss", "apply"].includes(operation) && options.expectedUpdatedAt !== undefined) {
          throw new InvalidArgumentError(`--expected-updated-at is not valid for ${operation}`);
        }
        orchestrationProposalsCommand(
          operation as "list" | "refresh" | "approve" | "dismiss" | "apply" | "rollback" | "observe",
          id,
          options.expectedUpdatedAt,
          options.autoRollback === true,
        );
      },
    );
  orchestration
    .command("policy")
    .argument("<operation>", "show or set")
    .option("--max-p95-ms <ms>", "SLO maximum P95 duration", positiveNumber)
    .option("--max-cost <usd>", "SLO maximum cost", positiveNumber)
    .option("--max-failure-rate <rate>", "SLO maximum failure rate", rate)
    .option("--min-coverage <rate>", "SLO minimum forecast coverage", rate)
    .option("--evaluation-window <n>", "bounded objective evaluation window", evaluationWindow)
    .option("--max-breach-rate <rate>", "allowed objective breach rate", rate)
    .option("--expected-updated-at <iso>", "reject a stale policy update")
    .action(
      (
        operation: string,
        options: {
          maxP95Ms?: number;
          maxCost?: number;
          maxFailureRate?: number;
          minCoverage?: number;
          evaluationWindow?: number;
          maxBreachRate?: number;
          expectedUpdatedAt?: string;
        },
      ) => {
        if (operation !== "show" && operation !== "set")
          throw new InvalidArgumentError("operation must be show or set");
        if (
          operation === "show" &&
          [
            options.maxP95Ms,
            options.maxCost,
            options.maxFailureRate,
            options.minCoverage,
            options.evaluationWindow,
            options.maxBreachRate,
            options.expectedUpdatedAt,
          ].some((value) => value !== undefined)
        ) {
          throw new InvalidArgumentError("policy show does not accept update options");
        }
        orchestrationPolicyCommand(
          operation,
          {
            ...(options.maxP95Ms === undefined ? {} : { maxP95DurationMs: options.maxP95Ms }),
            ...(options.maxCost === undefined ? {} : { maxCostUsd: options.maxCost }),
            ...(options.maxFailureRate === undefined ? {} : { maxFailureRate: options.maxFailureRate }),
            ...(options.minCoverage === undefined ? {} : { minForecastCoverage: options.minCoverage }),
          },
          {
            evaluationWindow: options.evaluationWindow,
            maxBreachRate: options.maxBreachRate,
            expectedUpdatedAt: options.expectedUpdatedAt,
          },
        );
      },
    );
  orchestration
    .command("index")
    .argument("<operation>", "show or refresh")
    .description("read or rebuild the bounded materialized orchestration summary")
    .action((operation: string) => {
      if (operation !== "show" && operation !== "refresh") {
        throw new InvalidArgumentError("operation must be show or refresh");
      }
      orchestrationIndexCommand(operation);
    });
  orchestration
    .command("rollout")
    .argument("<operation>", "list, start, advance, resume, or reconcile")
    .argument("[id]", "proposal id for start, advance, or resume")
    .option("--expected-updated-at <iso>", "reject a stale proposal when starting")
    .option("--min-samples <n>", "terminal canary samples required before promotion", rolloutSamples)
    .option("--auto-rollback", "roll back a regressed canary during reconciliation")
    .action(
      (
        operation: string,
        id: string | undefined,
        options: { expectedUpdatedAt?: string; minSamples?: number; autoRollback?: boolean },
      ) => {
        if (!(["list", "start", "advance", "resume", "reconcile"] as const).includes(operation as never)) {
          throw new InvalidArgumentError("rollout operation must be list, start, advance, resume, or reconcile");
        }
        if ((operation === "start" || operation === "advance" || operation === "resume") !== (id !== undefined)) {
          throw new InvalidArgumentError(`${operation} ${id === undefined ? "requires" : "does not accept"} an id`);
        }
        if (operation !== "start" && (options.expectedUpdatedAt !== undefined || options.minSamples !== undefined)) {
          throw new InvalidArgumentError(`start options are not valid for ${operation}`);
        }
        if (operation !== "reconcile" && options.autoRollback === true) {
          throw new InvalidArgumentError("--auto-rollback is valid only for reconcile");
        }
        orchestrationRolloutCommand(operation as "list" | "start" | "advance" | "resume" | "reconcile", id, options);
      },
    );
  orchestration
    .command("maintain")
    .option("--auto-rollback", "roll back terminal regressions")
    .option("--dry-run", "preview maintenance impact without workspace writes")
    .description("run one safe orchestration control tick without auto-approval or auto-apply")
    .action((options: { autoRollback?: boolean; dryRun?: boolean }) =>
      orchestrationMaintenanceCommand(options.autoRollback === true, options.dryRun === true),
    );
}
