import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command } from "commander";
import { checkForUpdate, formatUpdateNotice } from "./version-check.js";
import { agentImportCommand, agentListCommand, agentShowCommand } from "./commands/agent.js";
import { completionCommand } from "./commands/completion.js";
import { configSetCommand, configShowCommand } from "./commands/config.js";
import {
  evolveAcceptCommand,
  evolveAnalyzeCommand,
  evolveApplyCommand,
  evolveListCommand,
  evolveRejectCommand,
  evolveShowCommand,
} from "./commands/evolve.js";
import { initCommand } from "./commands/init.js";
import { mcpListCommand } from "./commands/mcp.js";
import { mcpServeCommand } from "./commands/mcp-serve.js";
import {
  memoryAddCommand,
  memoryApproveCommand,
  memoryCompactCommand,
  memoryListCommand,
  memoryRejectCommand,
  memoryRemoveCommand,
} from "./commands/memory.js";
import { replCommand } from "./commands/repl.js";
import { rewindCommand } from "./commands/rewind.js";
import { runTaskCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { sessionsCommand, sessionsPruneCommand, statusCommand } from "./commands/sessions.js";
import {
  skillCreateCommand,
  skillDisableCommand,
  skillEnableCommand,
  skillImportCommand,
  skillListCommand,
  skillRemoveCommand,
  skillShowCommand,
} from "./commands/skill.js";

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
  .option("-p, --plan", "plan first (read-only), confirm, then execute in the same session")
  .description("run a development task in the current project")
  .action(async (task: string, opts: { yes?: boolean; model?: string; json?: boolean; plan?: boolean }) => {
    await runTaskCommand(task, { mode: "edit", yes: opts.yes, model: opts.model, json: opts.json, plan: opts.plan });
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

const sessions = program
  .command("sessions")
  .description("list sessions of the current project")
  .action(() => {
    sessionsCommand();
  });
sessions
  .command("prune")
  .option("--older-than <days>", "remove sessions older than N days")
  .option("--keep-last <n>", "keep only the N most recent top-level sessions")
  .option("--dry-run", "show what would be removed without deleting")
  .description("delete old session traces (subagent runs are pruned with their parent's age)")
  .action((opts: { olderThan?: string; keepLast?: string; dryRun?: boolean }) => {
    sessionsPruneCommand(opts);
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
  .command("rewind")
  .argument("[session-id]", "session to rewind (default: most recent session with checkpoints)")
  .option("--dry-run", "show what would be restored/deleted without changing any file")
  .description("undo all file changes a session made (restore pre-session contents)")
  .action((sessionId: string | undefined, opts: { dryRun?: boolean }) => {
    rewindCommand(sessionId, opts);
  });

program
  .command("serve")
  .argument("[paths...]", "workspace paths to host (default: current directory)")
  .option("--port <n>", "port to listen on (0 = random)", "7373")
  .option(
    "--workspace <path>",
    "workspace path to host (repeatable; combined with positional paths)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .description("serve the web UI and agent API for one or more workspaces (127.0.0.1 only)")
  .action(async (paths: string[], opts: { port: string; workspace: string[] }) => {
    const port = Number.parseInt(opts.port, 10);
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      console.error(`invalid --port: ${opts.port}`);
      process.exitCode = 1;
      return;
    }
    await serveCommand({ port, workspaces: [...paths, ...opts.workspace] });
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
skill
  .command("import")
  .argument("<path>", "SKILL.md file (or its directory) with YAML frontmatter (Claude-style)")
  .option("-g, --global", "import into ~/.seekforge/skills (all projects) instead of this project")
  .option("-f, --force", "replace an existing skill with the same id")
  .description("import an external skill (e.g. Claude Code / Meta_Kim format)")
  .action((sourcePath: string, opts: { global?: boolean; force?: boolean }) => {
    skillImportCommand(sourcePath, opts);
  });
skill
  .command("enable")
  .argument("<skill-id>")
  .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
  .description("enable a skill (removes a disable marker for a builtin)")
  .action((id: string, opts: { global?: boolean }) => {
    skillEnableCommand(id, opts);
  });
skill
  .command("disable")
  .argument("<skill-id>")
  .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
  .description("disable a skill (writes a disable marker for a builtin)")
  .action((id: string, opts: { global?: boolean }) => {
    skillDisableCommand(id, opts);
  });
skill
  .command("remove")
  .argument("<skill-id>")
  .option("-g, --global", "act on ~/.seekforge/skills instead of this project")
  .description("delete a project/global skill dir (builtins must be disabled, not removed)")
  .action((id: string, opts: { global?: boolean }) => {
    skillRemoveCommand(id, opts);
  });

const agentCmd = program.command("agent").description("manage specialist subagents (dispatch_agent roster)");
agentCmd
  .command("list", { isDefault: true })
  .description("list available agents (project > global)")
  .action(() => {
    agentListCommand();
  });
agentCmd
  .command("show")
  .argument("<agent-id>")
  .description("print an agent's frontmatter fields and body")
  .action((id: string) => {
    agentShowCommand(id);
  });
agentCmd
  .command("import")
  .argument("<path>", "agent .md file with YAML frontmatter (Claude Code / Meta_Kim format)")
  .option("-g, --global", "import into ~/.seekforge/agents (all projects) instead of this project")
  .option("-f, --force", "replace an existing agent with the same id")
  .description("import an external agent definition")
  .action((sourcePath: string, opts: { global?: boolean; force?: boolean }) => {
    agentImportCommand(sourcePath, opts);
  });

const mcp = program.command("mcp").description("Model Context Protocol servers (mcpServers in config)");
mcp
  .command("list", { isDefault: true })
  .option("--tools", "also print each tool's description")
  .description("list configured MCP servers and the tools they expose")
  .action(async (opts: { tools?: boolean }) => {
    await mcpListCommand(opts);
  });

program
  .command("mcp-serve")
  .option("--allow-write", "expose write/execute tools too and auto-approve them (TRUSTED callers only)")
  .description("run SeekForge as an MCP server on stdio (read-only tool set by default)")
  .addHelpText(
    "after",
    `
Add to another agent's mcpServers config:
  { "mcpServers": { "seekforge": { "command": "seekforge", "args": ["mcp-serve"] } } }
`,
  )
  .action(async (opts: { allowWrite?: boolean }) => {
    await mcpServeCommand(opts);
  });

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
  .description("add a fact directly to project memory (user statement = approval)")
  .action((content: string[], opts: { type?: string; pending?: boolean }) => {
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
memory
  .command("compact")
  .option("--dry-run", "show what would be merged/removed without rewriting project.md")
  .description("collapse duplicate and near-duplicate facts in project.md (deterministic)")
  .action((opts: { dryRun?: boolean }) => {
    memoryCompactCommand(opts);
  });

const evolve = program
  .command("evolve")
  .description("score sessions and review self-evolution proposals (human-gated)");
evolve
  .command("analyze")
  .argument("[session-id]", "session to analyze (default: most recent completed/failed)")
  .description("score a session, write its reflection, and generate proposals")
  .action(async (sessionId?: string) => {
    await evolveAnalyzeCommand(sessionId);
  });
evolve
  .command("list", { isDefault: true })
  .description("list evolution proposals (pending first)")
  .action(() => {
    evolveListCommand();
  });
evolve
  .command("show")
  .argument("<proposal-id>")
  .description("print a proposal including the exact content to be applied")
  .action((id: string) => {
    evolveShowCommand(id);
  });
evolve
  .command("accept")
  .argument("<proposal-id>")
  .description("accept a pending proposal (apply it separately)")
  .action((id: string) => {
    evolveAcceptCommand(id);
  });
evolve
  .command("reject")
  .argument("<proposal-id>")
  .description("reject a pending proposal")
  .action((id: string) => {
    evolveRejectCommand(id);
  });
evolve
  .command("apply")
  .argument("<proposal-id>")
  .description("apply an accepted proposal to AGENTS.md / project.md / skills")
  .action((id: string) => {
    evolveApplyCommand(id);
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
  .command("completion")
  .argument("<shell>", "bash | zsh")
  .description("print a static shell completion script (source it from your rc file)")
  .action((shell: string) => {
    completionCommand(shell);
  });

program
  .command("chat", { isDefault: true })
  .option("-y, --yes", "auto-approve write/execute permissions")
  .option("-m, --model <model>", "model for the session")
  .description("interactive session (default when no command is given)")
  .action(async (opts: { yes?: boolean; model?: string }) => {
    await replCommand({ yes: opts.yes, model: opts.model });
  });

// Non-blocking update check: fire-and-forget at start, print the notice (to
// stderr, so it never pollutes stdout) after the command finishes. Skipped for
// --json / non-TTY output so machine consumers are unaffected.
const quietUpdate = process.argv.includes("--json") || !process.stderr.isTTY;
const updatePromise = quietUpdate ? Promise.resolve(null) : checkForUpdate(version);

program.parseAsync().finally(async () => {
  const latest = await updatePromise;
  if (latest) process.stderr.write(`${formatUpdateNotice(latest, version)}\n`);
});
