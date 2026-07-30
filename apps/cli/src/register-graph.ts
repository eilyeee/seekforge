import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import {
  graphDeleteCommand,
  graphArtifactMaterializeCommand,
  graphArtifactStoreCommand,
  graphDiagnoseCommand,
  graphListCommand,
  graphExplainCommand,
  graphExpansionPlanCommand,
  graphExpandCommand,
  graphHealthCommand,
  graphIntelligenceCommand,
  graphMigrateCommand,
  graphMigrationPlanCommand,
  graphPriorityCommand,
  graphRunCommand,
  graphSimulateCommand,
  graphResourcesCommand,
  graphShowCommand,
  graphValidateCommand,
} from "./commands/graph.js";

function graphPriority(value: string): number {
  if (!/^-?[0-9]+$/.test(value)) throw new InvalidArgumentError("priority must be an integer from -10 to 10");
  const priority = Number(value);
  if (!Number.isSafeInteger(priority) || priority < -10 || priority > 10) {
    throw new InvalidArgumentError("priority must be an integer from -10 to 10");
  }
  return priority;
}

function artifactSize(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new InvalidArgumentError("size must be a non-negative integer");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > 256 * 1024 * 1024) {
    throw new InvalidArgumentError("size must be at most 268435456 bytes");
  }
  return size;
}

function nonNegativeInteger(value: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new InvalidArgumentError("value must be a non-negative integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidArgumentError("value must be a safe integer");
  return parsed;
}

export function registerGraphCommands(
  program: Command,
  collect: (value: string, previous: string[]) => string[],
  rootProfile: () => string | undefined,
): void {
  const graph = program.command("graph").description("validate, run, resume, and inspect Engineering Graphs");
  graph
    .command("validate")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .option("--json", "print the normalized dry-run plan")
    .action((file: string, opts: { param?: string[]; json?: boolean }) =>
      graphValidateCommand(file, { params: opts.param, json: opts.json }),
    );
  graph
    .command("run")
    .argument("<file>")
    .option("--resume", "resume its durable checkpoint")
    .option("--restart", "explicitly replace an existing checkpoint")
    .option("--rerun <node-id>", "invalidate this node and its descendants", collect, [])
    .option("--approve <node-id>", "approve a gate for this run", collect, [])
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .option("-y, --yes", "authorize the workspace without prompting")
    .option("-m, --model <model>", "override model")
    .option("--profile <name>", "use a named config profile")
    .action(
      (
        file: string,
        opts: {
          resume?: boolean;
          restart?: boolean;
          rerun?: string[];
          approve?: string[];
          yes?: boolean;
          model?: string;
          profile?: string;
          param?: string[];
        },
      ) => graphRunCommand(file, { ...opts, params: opts.param, profile: opts.profile ?? rootProfile() }),
    );
  graph
    .command("resume")
    .argument("<file>")
    .option("--rerun <node-id>", "invalidate this node and its descendants", collect, [])
    .option("--approve <node-id>", "approve a gate for this run", collect, [])
    .option("--param <name=value>", "supply the same typed template parameter", collect, [])
    .option("-y, --yes", "authorize the workspace without prompting")
    .option("-m, --model <model>", "override model")
    .option("--profile <name>", "use a named config profile")
    .action(
      (
        file: string,
        opts: {
          rerun?: string[];
          approve?: string[];
          param?: string[];
          yes?: boolean;
          model?: string;
          profile?: string;
        },
      ) =>
        graphRunCommand(file, {
          ...opts,
          params: opts.param,
          resume: true,
          profile: opts.profile ?? rootProfile(),
        }),
    );
  graph.command("list").action(graphListCommand);
  graph
    .command("intelligence")
    .argument("[graph-id]")
    .description("report bounded adaptive-scheduling outcomes and anomalies")
    .action(graphIntelligenceCommand);
  graph
    .command("diagnose")
    .argument("<graph-id>")
    .description("check a Graph checkpoint against its retained event history")
    .action(graphDiagnoseCommand);
  graph
    .command("health")
    .argument("<graph-id>")
    .description("forecast critical path, drift, anomalies, and child lineage")
    .action(graphHealthCommand);
  graph
    .command("migration-plan")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .description("preview checkpoint invalidation for a new Graph definition")
    .action((file: string, opts: { param?: string[] }) => graphMigrationPlanCommand(file, opts.param));
  graph
    .command("expansion-plan")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .description("verify an append-only runtime Graph expansion")
    .action((file: string, opts: { param?: string[] }) => graphExpansionPlanCommand(file, opts.param));
  graph
    .command("expand")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .description("apply an append-only expansion through the coordinated tree transaction")
    .action((file: string, opts: { param?: string[] }) => graphExpandCommand(file, opts.param));
  graph
    .command("migrate")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .description("apply a safe migration to a paused or terminal Graph")
    .action((file: string, opts: { param?: string[] }) => graphMigrateCommand(file, opts.param));
  graph
    .command("artifact-materialize")
    .argument("<sha256>")
    .argument("<size>", "verified artifact size in bytes", artifactSize)
    .argument("<target>", "repository-relative materialization path")
    .option("--overwrite", "atomically replace an existing physical file")
    .description("materialize a verified content-addressed Graph artifact")
    .action((sha256: string, size: number, target: string, opts: { overwrite?: boolean }) =>
      graphArtifactMaterializeCommand(sha256, size, target, opts.overwrite === true),
    );
  graph
    .command("artifact-store")
    .argument("<operation>", "inspect or prune")
    .option("--max-bytes <n>", "maximum CAS bytes retained", nonNegativeInteger)
    .option("--max-age-days <n>", "maximum age for unreferenced blobs", nonNegativeInteger)
    .option("--dry-run", "preview CAS pruning")
    .description("inspect or prune the content-addressed Graph artifact store")
    .action((operation: string, opts: { maxBytes?: number; maxAgeDays?: number; dryRun?: boolean }) => {
      if (operation !== "inspect" && operation !== "prune") {
        throw new InvalidArgumentError("operation must be inspect or prune");
      }
      if (
        operation === "inspect" &&
        (opts.maxBytes !== undefined || opts.maxAgeDays !== undefined || opts.dryRun !== undefined)
      ) {
        throw new InvalidArgumentError("artifact-store inspect does not accept prune options");
      }
      graphArtifactStoreCommand(operation, opts);
    });
  graph
    .command("simulate")
    .argument("<file>")
    .option("--param <name=value>", "supply a typed template parameter", collect, [])
    .option("--worst-case", "include every configured retry")
    .description("forecast duration, resources, budgets, and critical path")
    .action((file: string, opts: { param?: string[]; worstCase?: boolean }) =>
      graphSimulateCommand(file, opts.param, opts.worstCase === true),
    );
  graph
    .command("explain")
    .argument("<graph-id>")
    .argument("<node-id>")
    .description("explain why a persisted Graph node can or cannot run")
    .action(graphExplainCommand);
  graph
    .command("priority")
    .argument("<graph-id>")
    .argument("<priority>", "integer from -10 to 10", graphPriority)
    .description("set automatic recovery priority for a persisted Graph")
    .action(graphPriorityCommand);
  graph
    .command("show")
    .argument("<graph-id>")
    .action((id: string) => graphShowCommand(id));
  graph
    .command("history")
    .argument("<graph-id>")
    .action((id: string) => graphShowCommand(id, true));
  graph.command("delete").argument("<graph-id>").action(graphDeleteCommand);
  graph
    .command("resources")
    .argument("<graph-id>")
    .argument("<operation>", "inspect, archive, prune, or promote")
    .option("--dry-run", "preview pruning")
    .option("--force", "prune without an archive marker")
    .option("--target <node-id>", "node id or fan-in for promotion", "fan-in")
    .action((graphId: string, operation: string, opts: { dryRun?: boolean; force?: boolean; target?: string }) => {
      if (!(["inspect", "archive", "prune", "promote"] as const).includes(operation as never)) {
        throw new InvalidArgumentError("operation must be inspect, archive, prune, or promote");
      }
      return graphResourcesCommand(graphId, operation as "inspect" | "archive" | "prune" | "promote", opts);
    });
}
