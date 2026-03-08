import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command } from "commander";
import { configSetCommand, configShowCommand } from "./commands/config.js";
import { initCommand } from "./commands/init.js";
import { memoryApproveCommand, memoryListCommand, memoryRejectCommand } from "./commands/memory.js";
import { replCommand } from "./commands/repl.js";
import { runTaskCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { sessionsCommand, statusCommand } from "./commands/sessions.js";
import { skillCreateCommand, skillListCommand, skillShowCommand } from "./commands/skill.js";

const program = new Command();

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

program
  .name("seekforge")
  .description("A local-first coding agent powered by DeepSeek.")
  .version(version);

program
  .command("run")
  .argument("<task>", "development task to perform (@path tokens inline file contents)")
  .option("-y, --yes", "auto-approve write/execute permissions (env-level still asks)")
  .option("-m, --model <model>", "override model (deepseek-chat | deepseek-reasoner)")
  .option("--json", "emit one JSON event per line (CI mode; prompts are denied, pair with -y)")
  .description("run a development task in the current project")
  .action(async (task: string, opts: { yes?: boolean; model?: string; json?: boolean }) => {
    await runTaskCommand(task, { mode: "edit", yes: opts.yes, model: opts.model, json: opts.json });
  });

program
  .command("ask")
  .argument("<question>", "question about the current project (@path tokens inline file contents)")
  .option("-m, --model <model>", "override model")
  .option("--json", "emit one JSON event per line (CI mode)")
  .description("read-only Q&A about the codebase (no writes, no commands)")
  .action(async (question: string, opts: { model?: string; json?: boolean }) => {
    await runTaskCommand(question, { mode: "ask", model: opts.model, json: opts.json });
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

program
  .command("serve")
  .option("--port <n>", "port to listen on (0 = random)", "7373")
  .description("serve the web UI and agent API for this workspace (127.0.0.1 only)")
  .action(async (opts: { port: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      console.error(`invalid --port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }
    await serveCommand({ port });
  });

const skill = program.command("skill").description("manage skills (procedure libraries)");
skill
  .command("list", { isDefault: true })
  .description("list available skills (project > global > builtin)")
  .action(() => {
    skillListCommand();
  });
skill
  .command("show")
  .argument("<skill-id>")
  .description("print a skill's metadata and SKILL.md")
  .action((id: string) => {
    skillShowCommand(id);
  });
skill
  .command("create")
  .argument("<skill-id>", "lowercase letters, digits, dashes")
  .description("scaffold a project skill in .seekforge/skills/<id>/")
  .action((id: string) => {
    skillCreateCommand(id);
  });

const memory = program.command("memory").description("inspect and curate project memory");
memory
  .command("list", { isDefault: true })
  .description("show project.md and pending memory candidates")
  .action(() => {
    memoryListCommand();
  });
memory
  .command("approve")
  .argument("<candidate-id>")
  .description("approve a candidate into project.md")
  .action((id: string) => {
    memoryApproveCommand(id);
  });
memory
  .command("reject")
  .argument("<candidate-id>")
  .description("reject a candidate")
  .action((id: string) => {
    memoryRejectCommand(id);
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

program
  .command("chat", { isDefault: true })
  .option("-y, --yes", "auto-approve write/execute permissions")
  .option("-m, --model <model>", "model for the session")
  .description("interactive session (default when no command is given)")
  .action(async (opts: { yes?: boolean; model?: string }) => {
    await replCommand({ yes: opts.yes, model: opts.model });
  });

program.parseAsync();
