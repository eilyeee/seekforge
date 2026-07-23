import { createRequire } from "node:module";
import { Command, InvalidArgumentError } from "commander";
import { fail, setColorEnabled, useColor } from "./colors.js";
import { loadConfig } from "./config.js";
import { detectLocale, setLocale } from "./i18n.js";
import { checkForUpdate, formatUpdateNotice } from "./version-check.js";
import { completionCommand } from "./commands/completion.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { printCommand } from "./commands/print.js";
import { auditCommand } from "./commands/audit.js";
import { replayCommand } from "./commands/replay.js";
import { replCommand } from "./commands/repl.js";
import { rewindCommand } from "./commands/rewind.js";
import {
  loopCleanupCommand,
  loopCommand,
  loopDeleteCommand,
  loopListCommand,
  loopResumeCommand,
  loopShowCommand,
} from "./commands/loop.js";
import { resolveCommand, resolveReviewCommand } from "./commands/resolve.js";
import { runTaskCommand } from "./commands/run.js";
import { sandboxRunCommand } from "./commands/sandbox.js";
import {
  scheduleAddCommand,
  scheduleHistoryCommand,
  scheduleInstallCommand,
  scheduleListCommand,
  scheduleNextCommand,
  scheduleRemoveCommand,
  scheduleRunCommand,
  scheduleSetEnabledCommand,
} from "./commands/schedule.js";
import { resolveOutputFormat } from "./output-format.js";
import { registerAgentCommands } from "./commands/register-agent.js";
import { registerConfigCommands } from "./commands/register-config.js";
import { registerEvolutionCommands } from "./commands/register-evolution.js";
import { registerMcpCommands } from "./commands/register-mcp.js";
import { registerMemoryCommands } from "./commands/register-memory.js";
import { registerSkillCommands } from "./commands/register-skill.js";
import { registerPluginCommands } from "./commands/register-plugin.js";
import { registerSecurityCommands } from "./commands/register-security.js";
import { serveCommand } from "./commands/serve.js";
import { updateCommand } from "./commands/update.js";
import { modelsCommand } from "./commands/models.js";
import { sessionsCommand, sessionsPruneCommand, statusCommand } from "./commands/sessions.js";
import { runInheritedCommand } from "./inherited-command.js";

const program = new Command();

// In a normal install/dev run this reads the package version. In a bun
// --compile sidecar binary (the Tauri-bundled `seekforge-server`) the
// package.json isn't on the virtual FS, so fall back to a constant rather
// than crashing — the version string is only used for display.
const version = ((): string => {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

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
      v === "--output-format=json" || v === "--output-format=stream-json" || v === "--output-format=stream-json-raw"
    );
  });
}
const machineMode = argvWantsMachineFormat(process.argv);

// Resolve the process-wide color default once: TTY + !NO_COLOR + !machine mode.
setColorEnabled(useColor({ machine: machineMode }));

// Scan argv for a global `--profile <name>` before commander parses, so the
// startup config read below (and the commands that loadConfig() without
// threading a profile) honor it. Mirrored into SEEKFORGE_PROFILE so loadConfig's
// env fallback covers every call site; an explicitly-set env still wins if no
// flag is given. The flag is also declared on the program/commands so it shows
// in --help and is accepted positionally.
function argvProfile(argv: string[]): string | undefined {
  const i = argv.indexOf("--profile");
  const next = i !== -1 ? argv[i + 1] : undefined;
  if (next !== undefined && !next.startsWith("-")) return next;
  const eq = argv.find((a) => a.startsWith("--profile="));
  return eq ? eq.slice("--profile=".length) : undefined;
}
const cliProfile = argvProfile(process.argv);
if (cliProfile !== undefined) process.env["SEEKFORGE_PROFILE"] = cliProfile;

// Resolve the CLI chrome locale once at startup: config.locale > env > en. An
// unknown --profile would throw here; swallow it so the locale read never
// crashes startup — the real command will surface the error via fail().
setLocale(
  (() => {
    try {
      return loadConfig(process.cwd()).locale;
    } catch {
      return undefined;
    }
  })() ?? detectLocale(),
);

/** commander collector for repeatable options (e.g. --add-dir). */
const collect = (val: string, prev: string[]): string[] => [...prev, val];

/** The global `--profile <name>` value (parsed onto the root program), if any. */
const rootProfile = (): string | undefined => program.opts<{ profile?: string }>().profile;

/** Parse a positive-integer option string; throws InvalidArgumentError on bad input. */
function parsePositiveInt(val: string): number {
  if (!/^[0-9]+$/.test(val)) throw new InvalidArgumentError("must be a positive integer");
  const n = Number(val);
  if (!Number.isSafeInteger(n) || n <= 0) throw new InvalidArgumentError("must be a positive integer");
  return n;
}

function parseNonNegativeInt(val: string): number {
  if (!/^[0-9]+$/.test(val)) throw new InvalidArgumentError("must be a non-negative integer");
  const n = Number(val);
  if (!Number.isSafeInteger(n)) throw new InvalidArgumentError("must be a non-negative integer");
  return n;
}

function parseRequirementMode(val: string): "quick" | "analyze" | "confirm" {
  if (val !== "quick" && val !== "analyze" && val !== "confirm") {
    throw new InvalidArgumentError('must be "quick", "analyze", or "confirm"');
  }
  return val;
}

/** Parse a positive-float option string (e.g. a USD budget); throws on bad input. */
function parsePositiveFloat(val: string): number {
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(val)) {
    throw new InvalidArgumentError("must be a positive number");
  }
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number");
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
  // Global: select a named config profile (also: SEEKFORGE_PROFILE env).
  .option("--profile <name>", "use a named config profile (profiles in config files; also SEEKFORGE_PROFILE env)")
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
    "--max-cost <usd>",
    "with -p: stop the run once cumulative cost reaches this budget (USD)",
    parsePositiveFloat,
  )
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
  .option("--disallowedTools <list>", "with -p: deny these tools (comma-separated)")
  .option(
    "--permission-mode <mode>",
    "with -p: default | acceptEdits | plan | bypassPermissions (also: confirm | auto)",
  )
  .option("--fallback-model <model>", "with -p: model to retry with if the primary is overloaded")
  .option("--output-style <style>", "with -p: default | concise | explanatory | learning")
  .option(
    "--settings <file>",
    "with -p: path to JSON settings file (layered over project config but below env/CLI flags)",
  )
  .option("--input-format <fmt>", "with -p: text (default) | stream-json (line-delimited user turns on stdin)")
  .option(
    "--dangerously-skip-permissions",
    "with -p: alias for -y — auto-approve write/execute (dangerous still refused; env still asks)",
  )
  .option(
    "--mcp-config <file>",
    "with -p: load MCP servers from a JSON file (merged over config, unless --strict-mcp-config)",
  )
  .option("--strict-mcp-config", "with -p: use only --mcp-config servers, ignore config-file MCP servers")
  .option(
    "--replay-user-messages",
    "with -p + --input-format stream-json: echo each user turn back as a stream-json event",
  )
  .option("--include-partial-messages", "with -p + --output-format stream-json: emit partial assistant text deltas");

type SharedRunOpts = {
  // commander camelCases hyphenated flags, but "--settings" is one word → `settings`.
  settings?: string;
  profile?: string;
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
  permissionMode?: string;
  fallbackModel?: string;
  outputStyle?: string;
  dangerouslySkipPermissions?: boolean;
  mcpConfig?: string;
  strictMcpConfig?: boolean;
  replayUserMessages?: boolean;
  includePartialMessages?: boolean;
};

program
  .command("run")
  .argument("<task>", "development task to perform (@path tokens inline file contents)")
  .option("-y, --yes", "auto-approve write/execute permissions (env-level still asks)")
  .option("-m, --model <model>", "override model (deepseek-v4-flash | deepseek-v4-pro)")
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
  .option("--append-system-prompt <text>", "append to the system prompt")
  .option("--allowedTools <list>", "only allow these tools (comma-separated)")
  .option("--disallowedTools <list>", "deny these tools (comma-separated)")
  .option("--permission-mode <mode>", "default | acceptEdits | plan | bypassPermissions (also: confirm | auto)")
  .option("--fallback-model <model>", "model to retry with if the primary is overloaded")
  .option("--output-style <style>", "default | concise | explanatory | learning")
  .option("--settings <file>", "path to JSON settings file (layered over project config but below env/CLI flags)")
  .option(
    "--dangerously-skip-permissions",
    "alias for -y — auto-approve write/execute (dangerous still refused; env still asks)",
  )
  .option("--mcp-config <file>", "load MCP servers from a JSON file (merged over config, unless --strict-mcp-config)")
  .option("--strict-mcp-config", "use only --mcp-config servers, ignore config-file MCP servers")
  .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
  .option("--plan", "plan first (read-only), confirm, then execute in the same session")
  .option("--max-cost <usd>", "stop the run once cumulative cost reaches this budget (USD)", parsePositiveFloat)
  .description("run a development task in the current project")
  .action(async (task: string, opts: SharedRunOpts & { plan?: boolean; maxCost?: number }) => {
    await runTaskCommand(task, {
      mode: "edit",
      yes: opts.yes,
      maxCostUsd: opts.maxCost,
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
      permissionMode: opts.permissionMode,
      fallbackModel: opts.fallbackModel,
      settingsFile: opts.settings,
      profile: opts.profile ?? rootProfile(),
      outputStyle: opts.outputStyle,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
      mcpConfig: opts.mcpConfig,
      strictMcpConfig: opts.strictMcpConfig,
      plan: opts.plan,
    });
  });

// Track E: run a task inside an isolated Docker container against the current
// workspace. The docker argv is built by the pure buildDockerRunArgs; --check
// prints it without spawning docker (no Docker install / no spend needed). The
// provider API key is passed by env-var NAME only; see docs/remote.md.
program
  .command("sandbox-run")
  .argument("<task>", "development task to perform inside an isolated container")
  .option(
    "--image <img>",
    "runner image tag (default seekforge-runner; build with `docker build -t seekforge-runner .`)",
  )
  .option(
    "--network <mode>",
    "container network: none | bridge | host (default bridge — the provider API needs egress)",
  )
  .option("--memory <m>", "container memory limit (e.g. 2g, 512m)")
  .option("--cpus <n>", "container CPU limit (e.g. 1.5)")
  .option("-m, --model <model>", "override model inside the container")
  .option("--permission-mode <mode>", "in-container permission mode (e.g. acceptEdits)")
  .option("--max-cost <usd>", "stop the run once cumulative cost reaches this budget (USD)", parsePositiveFloat)
  .option("--check", "dry-run: print the `docker run` command without executing it (no Docker/spend)")
  .description("run a task inside an isolated Docker container (mounts only this workspace)")
  .action(
    async (
      task: string,
      opts: {
        image?: string;
        network?: string;
        memory?: string;
        cpus?: string;
        model?: string;
        permissionMode?: string;
        maxCost?: number;
        check?: boolean;
      },
    ) => {
      await sandboxRunCommand(task, {
        image: opts.image,
        network: opts.network,
        memory: opts.memory,
        cpus: opts.cpus,
        model: opts.model,
        permissionMode: opts.permissionMode,
        maxCost: opts.maxCost,
        check: opts.check,
      });
    },
  );

// Autonomous GitHub issue→PR resolver (the OpenHands-style flagship). The
// COMMAND is user-initiated, so the git push + `gh pr create` are the USER's
// explicit action — the agent itself never pushes, keeping the push-approval
// moat intact. Headless + cost-bounded (--max-cost REQUIRED, like `schedule`).
// See docs/github.md. --dry-run does the fetch+branch+fix+verify but prints
// (never runs) the push/PR.
program
  .command("resolve")
  .argument("<issue>", "GitHub issue number or URL to resolve (e.g. 42 or https://github.com/o/r/issues/42)")
  .requiredOption(
    "--max-cost <usd>",
    "REQUIRED per-run cost cap in USD (an autonomous fix must be bounded)",
    parsePositiveFloat,
  )
  .option("--base <branch>", "base branch to open the PR against (default: main)")
  .option("-m, --model <model>", "override the model for the headless fix run")
  .option("--no-draft", "open a ready-for-review PR instead of a draft")
  .option("--no-worktree", "run in the current checkout instead of an isolated git worktree")
  .option("--wait-ci", "wait for PR checks and fail when a check fails")
  .option("--dry-run", "fetch + branch + fix + verify, but print (don't run) the push/PR")
  .description("autonomously fix a GitHub issue on a work branch and open a PR (agent fixes; the command pushes/PRs)")
  .action(
    async (
      issue: string,
      opts: {
        maxCost: number;
        base?: string;
        model?: string;
        draft?: boolean;
        dryRun?: boolean;
        worktree?: boolean;
        waitCi?: boolean;
      },
    ) => {
      await resolveCommand(issue, {
        maxCost: opts.maxCost,
        base: opts.base,
        model: opts.model,
        draft: opts.draft,
        dryRun: opts.dryRun,
        worktree: opts.worktree,
        waitCi: opts.waitCi,
      });
    },
  );

program
  .command("resolve-review")
  .argument("<pr>", "GitHub PR number or URL whose review feedback should be addressed")
  .requiredOption("--max-cost <usd>", "REQUIRED per-run cost cap in USD", parsePositiveFloat)
  .option("-m, --model <model>", "override the model for the headless review-fix run")
  .option("--no-worktree", "run in the current checkout instead of an isolated git worktree")
  .option("--wait-ci", "wait for PR checks after pushing")
  .option("--dry-run", "fix + verify, but print (don't run) commit/push")
  .description("address actionable review feedback on an existing PR and push the fixes")
  .action(
    async (
      pr: string,
      opts: { maxCost: number; model?: string; dryRun?: boolean; worktree?: boolean; waitCi?: boolean },
    ) => {
      await resolveReviewCommand(pr, opts);
    },
  );

program
  .command("loop")
  .argument("<task>", "task to drive to green (the verify command's exit 0)")
  .requiredOption("--verify <cmd>", "success criterion: shell command whose exit 0 means done")
  .option("--max-iters <n>", "max run iterations before giving up (default 8)", parsePositiveInt)
  .option("--budget <usd>", "cumulative cost cap in USD across iterations", parsePositiveFloat)
  .option("--token-budget <n>", "cumulative prompt + completion token cap", parsePositiveInt)
  .option("--max-duration <seconds>", "total wall-clock budget in seconds", parsePositiveFloat)
  .option("--max-verifies <n>", "maximum verifier executions including the pre-check", parsePositiveInt)
  .option("--verify-timeout <seconds>", "timeout for one verifier execution", parsePositiveFloat)
  .option("--agent-timeout <seconds>", "timeout for one agent attempt", parsePositiveFloat)
  .option("--agent-retries <n>", "retries for transient agent failures (default 1)", parseNonNegativeInt)
  .option("--requirements <mode>", "requirement gate: quick, analyze, or confirm", parseRequirementMode, "quick")
  .option("-y, --yes", "run autonomously (acceptEdits) without the auto-approve note")
  .option("-m, --model <model>", "override model")
  .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
  .option("--worktree [name]", "run in a retained isolated worktree (optional name)")
  .description("autonomously run → verify → continue until the verify command passes")
  .action(
    async (
      task: string,
      opts: {
        verify: string;
        maxIters?: number;
        budget?: number;
        tokenBudget?: number;
        maxDuration?: number;
        maxVerifies?: number;
        verifyTimeout?: number;
        agentTimeout?: number;
        agentRetries?: number;
        yes?: boolean;
        model?: string;
        profile?: string;
        worktree?: boolean | string;
        requirements: "quick" | "analyze" | "confirm";
      },
    ) => {
      await loopCommand(task, {
        verify: opts.verify,
        maxIters: opts.maxIters,
        budget: opts.budget,
        tokenBudget: opts.tokenBudget,
        maxDurationSeconds: opts.maxDuration,
        maxVerifyRuns: opts.maxVerifies,
        verifyTimeoutSeconds: opts.verifyTimeout,
        agentTimeoutSeconds: opts.agentTimeout,
        agentRetries: opts.agentRetries,
        yes: opts.yes,
        model: opts.model,
        profile: opts.profile ?? rootProfile(),
        worktree: opts.worktree,
        requirements: opts.requirements,
      });
    },
  );

program
  .command("loop-resume")
  .argument("<loop-id>", "persisted loop id to continue")
  .option("-y, --yes", "continue autonomously without the auto-approve note")
  .option("-m, --model <model>", "override model")
  .option("--add-iters <n>", "add iterations to the persisted loop limit", parsePositiveInt)
  .option("--add-budget <usd>", "add USD to the persisted cost budget", parsePositiveFloat)
  .option("--add-tokens <n>", "add tokens to the persisted token budget", parsePositiveInt)
  .option("--add-duration <seconds>", "add wall-clock seconds to the persisted duration budget", parsePositiveFloat)
  .option("--add-verifies <n>", "add verifier executions to the persisted limit", parsePositiveInt)
  .option("--approve-requirements", "approve a persisted confirm-mode requirement specification")
  .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
  .description("resume a persisted autonomous loop with its remaining limits and verification state")
  .action(
    async (
      loopId: string,
      opts: {
        yes?: boolean;
        model?: string;
        addIters?: number;
        addBudget?: number;
        addTokens?: number;
        addDuration?: number;
        addVerifies?: number;
        approveRequirements?: boolean;
        profile?: string;
      },
    ) => {
      await loopResumeCommand(loopId, {
        yes: opts.yes,
        model: opts.model,
        addIters: opts.addIters,
        addBudget: opts.addBudget,
        addTokens: opts.addTokens,
        addDurationSeconds: opts.addDuration,
        addVerifyRuns: opts.addVerifies,
        approveRequirements: opts.approveRequirements,
        profile: opts.profile ?? rootProfile(),
      });
    },
  );

program
  .command("loop-list")
  .description("list persisted loops in the base checkout and retained loop worktrees")
  .action(loopListCommand);
program.command("loop-show").argument("<loop-id>").description("show a persisted loop").action(loopShowCommand);
program
  .command("loop-delete")
  .argument("<loop-id>")
  .description("delete a persisted loop record")
  .action(loopDeleteCommand);
program
  .command("loop-cleanup")
  .argument("<name>", "retained loop worktree name, branch, or path")
  .option("--force", "remove a dirty inactive worktree and discard its changes")
  .description("remove a retained loop worktree")
  .action((name: string, opts: { force?: boolean }) => loopCleanupCommand(name, opts));

// Local scheduled jobs (Track E automation). Register a task to run on an
// interval or cron; `schedule run` is the tick the OS scheduler invokes. Every
// run is headless + cost-bounded (maxCostUsd is required) and produces a normal
// auditable session. See docs/scheduling.md.
const schedule = program
  .command("schedule")
  .description("local scheduled agent jobs (cron/launchd wire `schedule run`)");
schedule
  .command("add")
  .requiredOption("--task <prompt>", "the prompt the agent runs each tick")
  .option("--every <interval>", "run on an interval: 30m | 2h | 1d (seconds/minutes/hours/days/weeks)")
  .option("--cron <expr>", 'run on a 5-field cron schedule (e.g. "0 9 * * 1-5")')
  .requiredOption(
    "--max-cost <usd>",
    "REQUIRED per-run cost cap in USD (a scheduled run must be bounded)",
    parsePositiveFloat,
  )
  .option("--mode <mode>", "ask (read-only) | edit (may modify files)", "ask")
  .option("--id <name>", "explicit job id (default: derived from the task)")
  .description("register a scheduled job in .seekforge/schedules.json")
  .action((opts: { task: string; every?: string; cron?: string; maxCost: number; mode?: string; id?: string }) => {
    if (opts.mode !== undefined && opts.mode !== "ask" && opts.mode !== "edit") {
      fail(`invalid --mode "${opts.mode}" (expected ask | edit)`);
      return;
    }
    scheduleAddCommand({
      task: opts.task,
      every: opts.every,
      cron: opts.cron,
      maxCost: opts.maxCost,
      mode: opts.mode as "ask" | "edit" | undefined,
      id: opts.id,
    });
  });
schedule
  .command("list", { isDefault: true })
  .option("--json", "emit JSON")
  .description("list scheduled jobs (id, schedule, mode, budget, enabled, last run)")
  .action((opts: { json?: boolean }) => {
    scheduleListCommand(process.cwd(), opts.json === true);
  });
schedule
  .command("remove")
  .alias("rm")
  .argument("<id>", "job id to remove")
  .description("remove a scheduled job")
  .action((id: string) => {
    scheduleRemoveCommand(id);
  });
schedule
  .command("enable")
  .argument("<id>", "job id to enable")
  .description("enable a scheduled job")
  .action((id: string) => {
    scheduleSetEnabledCommand(id, true);
  });
schedule
  .command("disable")
  .argument("<id>", "job id to disable")
  .description("disable a scheduled job (kept in the registry, skipped by `run`)")
  .action((id: string) => {
    scheduleSetEnabledCommand(id, false);
  });
schedule
  .command("run")
  .option("--id <id>", "run one specific job now (forced), instead of all due jobs")
  .option("--dry-run", "show due jobs without running them")
  .option("--json", "emit JSON/JSONL")
  .description("run all DUE jobs now (the tick to wire into cron/launchd); each run is headless + cost-bounded")
  .action(async (opts: { id?: string; dryRun?: boolean; json?: boolean }) => {
    await scheduleRunCommand(opts);
  });
schedule
  .command("next")
  .option("--json", "emit JSON")
  .description("show the next eligible run time for enabled jobs")
  .action((opts: { json?: boolean }) => scheduleNextCommand(process.cwd(), opts.json === true));
schedule
  .command("history")
  .option("--id <id>", "filter by job id")
  .option("--json", "emit JSON")
  .description("show append-only scheduled run history")
  .action((opts: { id?: string; json?: boolean }) =>
    scheduleHistoryCommand(process.cwd(), opts.id, opts.json === true),
  );
for (const action of ["install", "uninstall", "status"] as const) {
  schedule
    .command(action)
    .option("--dry-run", "show the crontab operation without changing it")
    .option("--json", "emit JSON")
    .description(`${action} or inspect the per-project crontab tick`)
    .action((opts: { dryRun?: boolean; json?: boolean }) => scheduleInstallCommand(action, opts));
}

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
  .option("--append-system-prompt <text>", "append to the system prompt")
  .option("--allowedTools <list>", "only allow these tools (comma-separated)")
  .option("--disallowedTools <list>", "deny these tools (comma-separated)")
  .option("--fallback-model <model>", "model to retry with if the primary is overloaded")
  .option("--output-style <style>", "default | concise | explanatory | learning")
  .option("--settings <file>", "path to JSON settings file (layered over project config but below env/CLI flags)")
  .option("--profile <name>", "use a named config profile (also SEEKFORGE_PROFILE env)")
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
      settingsFile: opts.settings,
      profile: opts.profile ?? rootProfile(),
      fallbackModel: opts.fallbackModel,
      outputStyle: opts.outputStyle,
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
  .action(async () => {
    const code = await runInheritedCommand("git", ["diff"]);
    if (code !== 0) process.exitCode = code;
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
  .command("models")
  .description("list available DeepSeek models and their pricing")
  .action(() => {
    modelsCommand();
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
  .command("replay")
  .argument("<session-id>", "session to replay (see `seekforge sessions`)")
  .option("--verbose", "print full tool args and results")
  .description("re-render a stored session to the terminal (deterministic, no model calls)")
  .action((sessionId: string, opts: { verbose?: boolean }) => {
    replayCommand(sessionId, { verbose: opts.verbose });
  });

program
  .command("audit")
  .argument("<session-id>", "session to audit (see `seekforge sessions`)")
  .option("--json", "emit the raw SessionAudit as JSON instead of the markdown report")
  .option("-o, --output <path>", "write the report to a file instead of stdout")
  .description("export a reviewable report of what an agent did in a stored session (deterministic, no model calls)")
  .action((sessionId: string, opts: { json?: boolean; output?: string }) => {
    auditCommand(sessionId, { json: opts.json, output: opts.output });
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
    const port = /^\d+$/.test(opts.port) ? Number(opts.port) : Number.NaN;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      fail(`invalid --port "${opts.port}" (expected 0-65535)`);
      return;
    }
    await serveCommand({ port, workspaces: [...paths, ...opts.workspace] });
  });

registerSkillCommands(program);
registerPluginCommands(program);
registerAgentCommands(program);
registerMcpCommands(program);
registerMemoryCommands(program);
registerEvolutionCommands(program);
registerConfigCommands(program);
registerSecurityCommands(program);

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
      maxCost?: number;
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
      permissionMode?: string;
      fallbackModel?: string;
      outputStyle?: string;
      settings?: string;
      profile?: string;
      inputFormat?: string;
      dangerouslySkipPermissions?: boolean;
      mcpConfig?: string;
      strictMcpConfig?: boolean;
      replayUserMessages?: boolean;
      includePartialMessages?: boolean;
    }>();
    if (root.print !== undefined) {
      const inline = typeof root.print === "string" ? root.print : undefined;
      await printCommand(inline, {
        ask: root.ask,
        yes: root.yes ?? opts.yes,
        model: root.model ?? opts.model,
        maxCost: root.maxCost,
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
        permissionMode: root.permissionMode,
        fallbackModel: root.fallbackModel,
        settingsFile: root.settings,
        profile: root.profile,
        outputStyle: root.outputStyle,
        inputFormat: root.inputFormat,
        dangerouslySkipPermissions: root.dangerouslySkipPermissions,
        mcpConfig: root.mcpConfig,
        strictMcpConfig: root.strictMcpConfig,
        replayUserMessages: root.replayUserMessages,
        includePartialMessages: root.includePartialMessages,
      });
      return;
    }
    await replCommand({ yes: opts.yes, model: opts.model, settingsFile: root.settings, profile: root.profile });
  });

// Non-blocking update check: fire-and-forget at start, print the notice (to
// stderr, so it never pollutes stdout) after the command finishes. Skipped for
// machine output (json/stream-json), headless print mode, and non-TTY stderr
// so machine consumers see nothing but their data.
const quietUpdate =
  machineMode || process.argv.includes("-p") || process.argv.includes("--print") || !process.stderr.isTTY;
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
