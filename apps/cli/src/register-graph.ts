import type { Command } from "commander";
import {
  graphDeleteCommand,
  graphListCommand,
  graphRunCommand,
  graphShowCommand,
  graphValidateCommand,
} from "./commands/graph.js";

export function registerGraphCommands(
  program: Command,
  collect: (value: string, previous: string[]) => string[],
  rootProfile: () => string | undefined,
): void {
  const graph = program.command("graph").description("validate, run, resume, and inspect Engineering Graphs");
  graph.command("validate").argument("<file>").action(graphValidateCommand);
  graph
    .command("run")
    .argument("<file>")
    .option("--resume", "resume its durable checkpoint")
    .option("--restart", "explicitly replace an existing checkpoint")
    .option("--rerun <node-id>", "invalidate this node and its descendants", collect, [])
    .option("--approve <node-id>", "approve a gate for this run", collect, [])
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
        },
      ) => graphRunCommand(file, { ...opts, profile: opts.profile ?? rootProfile() }),
    );
  graph
    .command("resume")
    .argument("<file>")
    .option("--rerun <node-id>", "invalidate this node and its descendants", collect, [])
    .option("--approve <node-id>", "approve a gate for this run", collect, [])
    .option("-y, --yes", "authorize the workspace without prompting")
    .option("-m, --model <model>", "override model")
    .option("--profile <name>", "use a named config profile")
    .action(
      (file: string, opts: { rerun?: string[]; approve?: string[]; yes?: boolean; model?: string; profile?: string }) =>
        graphRunCommand(file, { ...opts, resume: true, profile: opts.profile ?? rootProfile() }),
    );
  graph.command("list").action(graphListCommand);
  graph
    .command("show")
    .argument("<graph-id>")
    .action((id: string) => graphShowCommand(id));
  graph
    .command("history")
    .argument("<graph-id>")
    .action((id: string) => graphShowCommand(id, true));
  graph.command("delete").argument("<graph-id>").action(graphDeleteCommand);
}
