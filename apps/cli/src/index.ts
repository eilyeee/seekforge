import { spawn } from "node:child_process";
import { Command } from "commander";
import { configSetCommand, configShowCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { runTaskCommand } from "./commands/run.js";
import { sessionsCommand, statusCommand } from "./commands/sessions.js";

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

program
  .command("sessions")
  .description("list sessions of the current project")
  .action(() => {
    sessionsCommand();
  });

program
  .command("status")
  .description("show project, config, and last-session status")
  .action(() => {
    statusCommand();
  });

program
  .command("resume")
  .argument("<session-id>", "session to continue (see `seekforge sessions`)")
  .argument("[task]", "follow-up instruction", "Continue the previous task to completion.")
  .option("-y, --yes", "auto-approve write/execute permissions")
  .option("-m, --model <model>", "override model")
  .description("continue an existing session with its full history")
  .action(async (sessionId: string, task: string, opts: { yes?: boolean; model?: string }) => {
    await runTaskCommand(task, { mode: "edit", yes: opts.yes, model: opts.model, resumeSessionId: sessionId });
  });

const config = program.command("config").description("show or change configuration");
config
  .command("show", { isDefault: true })
  .description("print merged config (api key masked)")
  .action(() => {
    configShowCommand();
  });
config
  .command("set")
  .argument("<key>", "apiKey | model | baseUrl")
  .argument("<value>")
  .option("-g, --global", "write to ~/.seekforge/config.json instead of the project")
  .description("set a config value")
  .action((key: string, value: string, opts: { global?: boolean }) => {
    configSetCommand(key, value, opts);
  });

program.parseAsync();
