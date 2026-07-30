import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { orchestrationProposalsCommand, orchestrationReportCommand } from "./commands/orchestration.js";

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
    .action((options: { maxP95Ms?: number; maxCost?: number; maxFailureRate?: number; minCoverage?: number }) =>
      orchestrationReportCommand({
        ...(options.maxP95Ms === undefined ? {} : { maxP95DurationMs: options.maxP95Ms }),
        ...(options.maxCost === undefined ? {} : { maxCostUsd: options.maxCost }),
        ...(options.maxFailureRate === undefined ? {} : { maxFailureRate: options.maxFailureRate }),
        ...(options.minCoverage === undefined ? {} : { minForecastCoverage: options.minCoverage }),
      }),
    );
  orchestration
    .command("proposals")
    .argument("<operation>", "list, refresh, approve, or dismiss")
    .argument("[id]", "proposal id for approve or dismiss")
    .option("--expected-updated-at <iso>", "reject review when the retained proposal version changed")
    .action((operation: string, id: string | undefined, options: { expectedUpdatedAt?: string }) => {
      if (!(["list", "refresh", "approve", "dismiss"] as const).includes(operation as never)) {
        throw new InvalidArgumentError("operation must be list, refresh, approve, or dismiss");
      }
      orchestrationProposalsCommand(
        operation as "list" | "refresh" | "approve" | "dismiss",
        id,
        options.expectedUpdatedAt,
      );
    });
}
