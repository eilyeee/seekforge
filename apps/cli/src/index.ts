import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { fail, setColorEnabled, useColor } from "./colors.js";
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
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { mcpAddCommand, mcpListCommand, mcpRemoveCommand } from "./commands/mcp.js";
import { mcpServeCommand } from "./commands/mcp-serve.js";
import { printCommand } from "./commands/print.js";
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
import { resolveOutputFormat } from "./output-format.js";
import { serveCommand } from "./commands/serve.js";
import { updateCommand } from "./commands/update.js";
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

// A machine output mode is requested when argv asks for json/stream-json (via
// --json or --output-format json|stream-json). Used to gate BOTH color (must
// be byte-clean) and the update-notifier (must not write chrome). The per-run
// renderer in run.ts threads a precise `color` flag too; this argv scan
// resolves the process-wide default before commander parses. `--output-format
// text` is NOT a machine mode — text output keeps its colors on a TTY.
function argvWantsMachineFormat(argv: string[]): boolean {
  if (argv.includes("--json")) return true;
  const i = argv.indexOf("--output-format");
  if (i !== -1) {
    const v = argv[i + 1]?.toLowerCase();
    return v === "json" || v === "stream-json" || v === "stream-json-raw";
  }
  // `--output-format=json` form.
  return argv.some((a) => {
    const v = a.toLowerCase();
    return (
      v === "--output-format=json" ||
      v === "--output-format=stream-json" ||
      v === "--output-format=stream-json-raw"
    );
  });
}
const machineMode = argvWantsMachineFormat(process.argv);

// Resolve the process-wide color default once: TTY + !NO_COLOR + !machine mode.
setColorEnabled(useColor({ machine: machineMode }));

/** commander collector for repeatable options (e.g. --add-dir). */
const collect = (val: string, prev: string[]): string[] => [...prev, val];

/** Parse a positive-integer option string; throws InvalidArgumentError on bad input. */
function parsePositiveInt(val: string): number {
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n) || n <= 0) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

/** Resolve --output-format / --json, printing a clean error and exiting on bad input. */
function resolveOutputFormatOrExit(opts: { outputFormat?: string; json?: boolean }) {
  try {
    return resolveOutputFormat(opts);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(process.exitCode ?? 1);
  }
}

program
  .name("seekforge")
  .description("A local-first coding agent powered by DeepSeek.")
  // Required for `mcp add`'s passThroughOptions (literal command flags).
  .enablePositionalOptions()
  .version(version);

// Top-level headless print mode: `seekforge -p "<prompt>"` (also reads piped
// stdin). Routes to the print handler before the default `chat` command would
// open an interactive session. Common run flags are accepted here too.
program
  .option("-p, --print [prompt]", "headless single run: stream the result to stdout and exit (reads piped stdin)")
  .option("--ask", "with -p: read-only Q&A mode (no writes/commands)")
  .option("-y, --yes", "with -p: auto-approve write/execute permissions")
  .option("-m, --model <model>", "with -p: override model")
  .option(
    "--output-format <fmt>",
    "with -p: text | json (Claude-style result) | stream-json (Claude-style envelopes) | stream-json-raw (raw events)",
  )
  .option("--json", "with -p: alias for --output-format stream-json (machine mode; no color/chrome)")
  .option("-c, --continue", "with -p: resume the most recent session")
  .option("--resume <id>", "with -p: resume a specific session")
  .option("--add-dir <path>", "with -p: extra read-only root for @-references (repeatable)", collect, [] as string[])
  .option("--max-turns <n>", "with -p: cap agent turns", parsePositiveInt)
  .option("--verbose", "with -p: print full tool args and results")
  .option("--system-prompt <text>", "with -p: replace the system prompt entirely")
  .option("--append-system-prompt <text>", "with -p: append text to the system prompt")
  .option("--allowedTools <list>", "with -p: only allow these tools (comma-separated)")
  .option("--disallowedTools <list>", "with -p: deny these tools (comma-separated)");

type SharedRunOpts = {
  yes?: boolean;
  model?: string;
  json?: boolean;
  outputFormat?: string;
  continue?: boolean;
  resume?: string;
  addDir?: string[];
  maxTurns?: number;
  verbose?: boolean;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
};

program
  .command("run")
  .argument("<task>", "development task to perform (@path tokens inline file contents)")
  .option("-y, --yes", "auto-approve write/execute permissions (env-level still asks)")
  .option("-m, --model <model>", "override model (deepseek-chat | deepseek-reasoner)")
  .option(
    "--output-format <fmt>",
    "text | json (Claude-style result) | stream-json (Claude-style envelopes) | stream-json-raw (raw events)",
  )
  .option("--json", "alias for --output-format stream-json (CI mode; prompts denied, pair with -y)")
  .option("-c, --continue", "resume the most recent session")
  .option("--resume <id>", "resume a specific session (see `seekforge sessions`)")
  .option("--add-dir <path>", "extra read-only root for @-references (repeatable)", collect, [] as string[])
  .option("--max-turns <n>", "cap agent turns", parsePositiveInt)
  .option("--verbose", "print full tool args and results")
  .option("--system-prompt <text>", "replace the system prompt entirely")
  .option("--append-system-prompt <text>", "append to the system prompt (not yet supported)")
  .option("--allowedTools <list>", "only allow these tools (comma-separated)")
  .option("--disallowedTools <list>", "deny these tools (comma-separated)")
  .option("--plan", "plan first (read-only), confirm, then execute in the same session")
  .description("run a development task in the current project")
  .action(async (task: string, opts: SharedRunOpts & { plan?: boolean }) => {
    await runTaskCommand(task, {
      mode: "edit",
      yes: opts.yes,
      model: opts.model,
      outputFormat: resolveOutputFormatOrExit(opts),
      continueLast: opts.continue,
      resumeSessionId: opts.resume,
      addDirs: opts.addDir,
      maxTurns: opts.maxTurns,
      verbose: opts.verbose,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
      plan: opts.plan,
    });
  });

program
  .command("ask")
  .argument("<question>", "question about the current project (@path tokens inline file contents)")
  .option("-m, --model <model>", "override model")
  .option(
    "--output-format <fmt>",
    "text | json (Claude-style result) | stream-json (Claude-style envelopes) | stream-json-raw (raw events)",
  )
  .option("--json", "alias for --output-format stream-json (CI mode)")
  .option("-c, --continue", "resume the most recent session")
  .option("--resume <id>", "resume a specific session")
  .option("--add-dir <path>", "extra read-only root for @-references (repeatable)", collect, [] as string[])
  .option("--max-turns <n>", "cap agent turns", parsePositiveInt)
  .option("--verbose", "print full tool args and results")
  .option("--system-prompt <text>", "replace the system prompt entirely")
  .option("--append-system-prompt <text>", "append to the system prompt (not yet supported)")
  .option("--allowedTools <list>", "only allow these tools (comma-separated)")
  .option("--disallowedTools <list>", "deny these tools (comma-separated)")
  .description("read-only Q&A about the codebase (no writes, no commands)")
  .action(async (question: string, opts: SharedRunOpts) => {
    await runTaskCommand(question, {
      mode: "ask",
      model: opts.model,
      outputFormat: resolveOutputFormatOrExit(opts),
      continueLast: opts.continue,
      resumeSessionId: opts.resume,
      addDirs: opts.addDir,
      maxTurns: opts.maxTurns,
      verbose: opts.verbose,
      systemPrompt: opts.systemPrompt,
      appendSystemPrompt: opts.appendSystemPrompt,
      allowedTools: opts.allowedTools,
      disallowedTools: opts.disallowedTools,
    });
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
  .command("doctor")
  .description("run environment diagnostics (api key, node, git, runtime, mcp, editor, clipboard)")
  .action(() => {
    doctorCommand();
  });

program
  .command("update")
  .alias("upgrade")
  .description("check npm for a newer seekforge and print the install command")
  .action(async () => {
    await updateCommand();
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
      fail(`invalid --port "${opts.port}" (expected 0-65535)`);
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
mcp
  .command("add")
  .argument("<name>", "server name (key under mcpServers)")
  .argument("<command...>", "command to spawn, then its args (e.g. npx -y @scope/server .)")
  .option("-g, --global", "write to ~/.seekforge/config.json instead of the project")
  // Treat everything after <name> literally so flags like `-y` belong to the
  // spawned command, not to seekforge. Put -g before the command, e.g.
  //   seekforge mcp add -g fs npx -y @scope/server .
  .passThroughOptions()
  .description("add a stdio MCP server to config")
  .action((name: string, command: string[], opts: { global?: boolean }) => {
    mcpAddCommand(name, command, opts);
  });
mcp
  .command("remove")
  .alias("rm")
  .argument("<name>", "server name to remove")
  .option("-g, --global", "edit ~/.seekforge/config.json instead of the project")
  .description("remove an MCP server from config")
  .action((name: string, opts: { global?: boolean }) => {
    mcpRemoveCommand(name, opts);
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
  .argument("<key>", "apiKey | model | baseUrl | runtimeBin | commandAllowlist")
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
  .description("interactive session (default when no command is given; `-p` for headless print mode)")
  .action(async (opts: { yes?: boolean; model?: string }) => {
    // `seekforge -p "…"` (or piped stdin) takes precedence over interactive chat.
    const root = program.opts<{
      print?: string | boolean;
      ask?: boolean;
      yes?: boolean;
      model?: string;
      outputFormat?: string;
      json?: boolean;
      continue?: boolean;
      resume?: string;
      addDir?: string[];
      maxTurns?: number;
      verbose?: boolean;
      systemPrompt?: string;
      appendSystemPrompt?: string;
      allowedTools?: string;
      disallowedTools?: string;
    }>();
    if (root.print !== undefined) {
      const inline = typeof root.print === "string" ? root.print : undefined;
      await printCommand(inline, {
        ask: root.ask,
        yes: root.yes ?? opts.yes,
        model: root.model ?? opts.model,
        outputFormat: root.outputFormat,
        json: root.json,
        continueLast: root.continue,
        resume: root.resume,
        addDir: root.addDir,
        maxTurns: root.maxTurns !== undefined ? String(root.maxTurns) : undefined,
        verbose: root.verbose,
        systemPrompt: root.systemPrompt,
        appendSystemPrompt: root.appendSystemPrompt,
        allowedTools: root.allowedTools,
        disallowedTools: root.disallowedTools,
      });
      return;
    }
    await replCommand({ yes: opts.yes, model: opts.model });
  });

// Non-blocking update check: fire-and-forget at start, print the notice (to
// stderr, so it never pollutes stdout) after the command finishes. Skipped for
// machine output (json/stream-json), headless print mode, and non-TTY stderr
// so machine consumers see nothing but their data.
const quietUpdate =
  machineMode ||
  process.argv.includes("-p") ||
  process.argv.includes("--print") ||
  !process.stderr.isTTY;
const updatePromise = quietUpdate ? Promise.resolve(null) : checkForUpdate(version);

/** True for the shape carried by core's AgentError (code + message + optional hint). */
function isAgentErrorLike(err: unknown): err is { message: string; hint?: string } {
  return typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string";
}

program
  .parseAsync()
  .catch((err: unknown) => {
    // Top-level safety net: any uncaught error becomes one consistent
    // `error: <message>` (+ hint when present) on stderr with a non-zero exit.
    const message = isAgentErrorLike(err) ? err.message : String(err);
    const hint = isAgentErrorLike(err) ? err.hint : undefined;
    fail(message, { hint });
  })
  .finally(async () => {
    const latest = await updatePromise;
    if (latest) process.stderr.write(`${formatUpdateNotice(latest, version)}\n`);
  });
