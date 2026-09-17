/**
 * Launch-flag parsing for the seekforge-tui binary. Pure and dependency-free:
 * index.tsx passes process.argv.slice(2) and acts on the result.
 *
 * The accepted set is closed: an unknown flag or a stray argument is an error
 * rather than silently ignored, because a flag that "works" by doing nothing
 * (`--permission-mode plan` before this parser knew it) is worse than a
 * refusal. The CLI launches the TUI for bare `seekforge` and forwards its
 * interactive flags, so every flag it may forward is accepted here even when
 * it only has a TUI-side default (`--strict-mcp-config`, `--verbose`).
 */

import type { ApprovalSetting } from "./model.js";

export type TuiArgs = {
  /** -c / --continue: resume the most recent session of this project. */
  continueLast: boolean;
  /** --resume <id>: resume this session. */
  resume?: string;
  /** --vim / --no-vim override the config's vim setting; absent = use config. */
  vim?: boolean;
  /** -m / --model <name>. */
  model?: string;
  /** -h / --help: print TUI_HELP and exit. */
  help: boolean;
  /** --permission-mode <mode> (validated). */
  permissionMode?: string;
  /** -y / --yes / --dangerously-skip-permissions: start in auto approval. */
  yes?: boolean;
  /** --add-dir <dir> (repeatable): directories outside the project the file tools and @ references may use. */
  addDirs?: string[];
  /** --settings <file>: a user-owned JSON settings layer. */
  settings?: string;
  /** --profile <name>: a named config overlay. */
  profile?: string;
  /** --mcp-config <file>: extra MCP servers, merged over config. */
  mcpConfig?: string;
  /** --strict-mcp-config: use only the --mcp-config servers. */
  strictMcpConfig?: boolean;
  /** --append-system-prompt <text>: appended to every run's system prompt. */
  appendSystemPrompt?: string;
  /** --verbose: start with verbose transcript rendering (Ctrl+O toggles). */
  verbose?: boolean;
  /** Set when argv cannot be honored; nothing else should be acted on. */
  error?: string;
};

type ValueFlag = "model" | "resume" | "permissionMode" | "settings" | "profile" | "mcpConfig" | "appendSystemPrompt";

const VALUE_FLAGS: Readonly<Record<string, ValueFlag | "addDir">> = {
  "--model": "model",
  "-m": "model",
  "--resume": "resume",
  "--permission-mode": "permissionMode",
  "--add-dir": "addDir",
  "--settings": "settings",
  "--profile": "profile",
  "--mcp-config": "mcpConfig",
  "--append-system-prompt": "appendSystemPrompt",
};

/** Claude-compatible and native permission-mode names → the TUI approval setting. */
const PERMISSION_MODES: Readonly<Record<string, ApprovalSetting>> = {
  default: "confirm",
  confirm: "confirm",
  acceptEdits: "acceptEdits",
  bypassPermissions: "auto",
  auto: "auto",
  plan: "plan",
};

export const PERMISSION_MODE_NAMES = Object.keys(PERMISSION_MODES);

function fail(args: TuiArgs, error: string): TuiArgs {
  return { ...args, error };
}

/** Parses TUI launch flags; argv excludes node+script. */
export function parseTuiArgs(argv: readonly string[]): TuiArgs {
  let args: TuiArgs = { continueLast: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const target = VALUE_FLAGS[flag];
    if (target !== undefined) {
      let value: string | undefined;
      if (eq > 0) {
        value = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        // A following flag is not a value; `--flag=-x` is the way to pass one.
        if (next !== undefined && !(next.startsWith("-") && next !== "-")) {
          value = next;
          i++;
        }
      }
      if (value === undefined || value === "") return fail(args, `option '${flag}' needs a value`);
      if (target === "addDir") {
        args = { ...args, addDirs: [...(args.addDirs ?? []), value] };
      } else if (target === "permissionMode" && !Object.hasOwn(PERMISSION_MODES, value)) {
        return fail(args, `unknown permission mode '${value}' (use ${PERMISSION_MODE_NAMES.join(", ")})`);
      } else {
        args = { ...args, [target]: value };
      }
      continue;
    }
    if (eq > 0) return fail(args, `option '${flag}' takes no value`);
    switch (arg) {
      case "-c":
      case "--continue":
        args.continueLast = true;
        break;
      case "--vim":
        args.vim = true;
        break;
      case "--no-vim":
        args.vim = false;
        break;
      case "-y":
      case "--yes":
      case "--dangerously-skip-permissions":
        args.yes = true;
        break;
      case "--strict-mcp-config":
        args.strictMcpConfig = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        return fail(
          args,
          arg.startsWith("-")
            ? `unknown option '${arg}'`
            : `unexpected argument '${arg}' (the TUI takes no task argument)`,
        );
    }
  }
  if (args.continueLast && args.resume !== undefined) {
    return fail(args, "use either -c/--continue or --resume <id>, not both");
  }
  return args;
}

/**
 * The approval setting every tab starts in, or undefined for the default.
 * --permission-mode wins over -y, as in the CLI.
 */
export function initialApprovalFor(args: TuiArgs): ApprovalSetting | undefined {
  if (args.permissionMode !== undefined) return PERMISSION_MODES[args.permissionMode];
  return args.yes ? "auto" : undefined;
}

/** Short usage text printed for -h/--help and after a flag error. */
export const TUI_HELP = `Usage: seekforge-tui [options]

Options:
  -c, --continue                resume the most recent session of this project
  --resume <id>                 resume a specific session (see /sessions)
  -m, --model <name>            model for the session (e.g. deepseek-v4-pro)
  --permission-mode <mode>      start in default | acceptEdits | plan | bypassPermissions
                                (also: confirm | auto)
  -y, --yes                     start in auto approval (alias: --dangerously-skip-permissions);
                                dangerous commands are still refused, env-level still asks
  --add-dir <dir>               a directory the file tools and @ references may use (repeatable)
  --settings <file>             JSON settings file layered over the config files
  --profile <name>              named config profile (also SEEKFORGE_PROFILE)
  --mcp-config <file>           MCP servers from a JSON file, merged over config
  --strict-mcp-config           use only the --mcp-config servers
  --append-system-prompt <text> append text to every run's system prompt
  --vim / --no-vim              start the composer in (or out of) vim mode
  --verbose                     start with verbose transcript output (Ctrl+O toggles)
  -h, --help                    show this help and exit
`;
