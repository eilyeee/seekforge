import { spawn } from "node:child_process";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runTaskCommand } from "./commands/run.js";

const program = new Command();

program
  .name("seekforge")
  .description("A local-first coding agent powered by DeepSeek.")
  .version("0.0.1");

program
  .command("run")
  .argument("<task>", "development task to perform")
  .option("-y, --yes", "auto-approve write/execute permissions (env-level still asks)")
  .option("-m, --model <model>", "override model (deepseek-chat | deepseek-reasoner)")
  .description("run a development task in the current project")
  .action(async (task: string, opts: { yes?: boolean; model?: string }) => {
    await runTaskCommand(task, { mode: "edit", yes: opts.yes, model: opts.model });
  });

program
  .command("ask")
  .argument("<question>", "question about the current project")
  .option("-m, --model <model>", "override model")
  .description("read-only Q&A about the codebase (no writes, no commands)")
  .action(async (question: string, opts: { model?: string }) => {
    await runTaskCommand(question, { mode: "ask", model: opts.model });
  });

program
  .command("init")
  .description("initialize .seekforge/ and AGENTS.md in the current project")
  .action(() => {
    initCommand();
  });

program
  .command("diff")
  .description("show current git diff")
  .action(() => {
    spawn("git", ["diff"], { stdio: "inherit" });
  });

program.parseAsync();
