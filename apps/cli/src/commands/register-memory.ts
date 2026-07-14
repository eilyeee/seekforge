import { InvalidArgumentError, type Command } from "commander";
import {
  memoryAddCommand,
  memoryApproveCommand,
  memoryCompactCommand,
  memoryListCommand,
  memoryRejectCommand,
  memoryRemoveCommand,
  memoryStatsCommand,
} from "./memory.js";

function parseNonNegativeInt(val: string): number {
  if (!/^[0-9]+$/.test(val)) throw new InvalidArgumentError("must be a non-negative integer");
  const n = Number(val);
  if (!Number.isSafeInteger(n)) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

export function registerMemoryCommands(program: Command): void {
  const memory = program.command("memory").description("inspect and curate project memory");
  memory
    .command("list", { isDefault: true })
    .description("show project.md and pending memory candidates")
    .action(() => {
      memoryListCommand();
    });
  memory
    .command("add")
    .argument("<content...>", "fact text (words are joined with spaces)")
    .option("--type <type>", "command | path | convention | tech | task_pattern", "convention")
    .option("--pending", "queue as a pending candidate instead of writing to project.md")
    .option("--user", "write to user memory (~/.seekforge, all projects) instead of this project")
    .description("add a fact directly to memory (user statement = approval)")
    .action((content: string[], opts: { type?: string; pending?: boolean; user?: boolean }) => {
      memoryAddCommand(content, opts);
    });
  memory
    .command("remove")
    .argument("<selector>", "fact number, unique substring, or mc- candidate id")
    .description("remove a fact from project.md, or delete a candidate entirely (mc- id)")
    .action((selector: string) => {
      memoryRemoveCommand(selector);
    });
  memory
    .command("approve")
    .argument("<candidate-id>")
    .option("--user", "approve into user memory (~/.seekforge, all projects)")
    .description("approve a candidate into project (or user) memory")
    .action((id: string, opts: { user?: boolean }) => {
      memoryApproveCommand(id, opts);
    });
  memory
    .command("reject")
    .argument("<candidate-id>")
    .description("reject a candidate")
    .action((id: string) => {
      memoryRejectCommand(id);
    });
  memory
    .command("stats")
    .description("print memory extraction-quality stats (read-only)")
    .action(() => {
      memoryStatsCommand();
    });
  memory
    .command("compact")
    .option("--dry-run", "show what would be merged/removed without rewriting project.md")
    .option(
      "--prune-unused <days>",
      "archive facts never used and older than <days> to project-archive.md",
      parseNonNegativeInt,
    )
    .description("collapse duplicate and near-duplicate facts in project.md (deterministic)")
    .action((opts: { dryRun?: boolean; pruneUnused?: number }) => {
      memoryCompactCommand({ dryRun: opts.dryRun, pruneUnusedDays: opts.pruneUnused });
    });
}
