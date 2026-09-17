// Bare `seekforge` in a terminal opens the Ink TUI; `seekforge chat`, `--classic`
// and SEEKFORGE_CLASSIC_REPL keep the readline REPL, and so does anything
// without a TTY on both ends (piped input keeps working exactly as before).
//
// The TUI runs IN this process rather than as a child: it suspends itself with
// SIGTSTP on Ctrl+Z, and a stopped child under a still-running parent leaves the
// shell waiting on the parent with nothing in the foreground.
//
// The TUI reads only a few launch flags. A session flag it would drop is not
// dropped: the classic REPL honors every one of them, so the launch falls back
// to it and says which flag caused that.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The root/chat flags as commander parsed them (only what the decision reads). */
export type InteractiveFlags = {
  model?: string;
  continue?: boolean;
  classic?: boolean;
  [flag: string]: unknown;
};

export type FrontendDecision = { kind: "tui"; args: string[] } | { kind: "repl"; unsupported?: string[] };

/** Flags the TUI honors, by commander attribute name. */
const TUI_FLAGS = new Set(["model", "continue", "classic"]);

/** commander attribute name → the flag a user typed. */
const FLAG_NAMES: Record<string, string> = {
  yes: "--yes",
  resume: "--resume",
  forkSession: "--fork-session",
  sessionId: "--session-id",
  permissionMode: "--permission-mode",
  dangerouslySkipPermissions: "--dangerously-skip-permissions",
  ask: "--ask",
  addDir: "--add-dir",
  mcpConfig: "--mcp-config",
  strictMcpConfig: "--strict-mcp-config",
  systemPrompt: "--system-prompt",
  systemPromptFile: "--system-prompt-file",
  appendSystemPrompt: "--append-system-prompt",
  appendSystemPromptFile: "--append-system-prompt-file",
  outputStyle: "--output-style",
  allowedTools: "--allowedTools",
  disallowedTools: "--disallowedTools",
  maxTurns: "--max-turns",
  maxCost: "--max-cost",
  fallbackModel: "--fallback-model",
  verbose: "--verbose",
  settings: "--settings",
  profile: "--profile",
  agents: "--agents",
  debug: "--debug",
};

function isSet(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Truthy spellings of SEEKFORGE_CLASSIC_REPL. */
export function classicReplRequested(env: Record<string, string | undefined>): boolean {
  const value = env["SEEKFORGE_CLASSIC_REPL"]?.trim().toLowerCase();
  return value !== undefined && value !== "" && value !== "0" && value !== "false" && value !== "no";
}

export function decideInteractiveFrontend(input: {
  /** `seekforge chat` was typed (not the implicit default command). */
  explicitChat: boolean;
  flags: InteractiveFlags;
  env: Record<string, string | undefined>;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}): FrontendDecision {
  const { flags, env } = input;
  if (input.explicitChat || flags.classic === true || classicReplRequested(env)) return { kind: "repl" };
  if (!input.stdinIsTTY || !input.stdoutIsTTY) return { kind: "repl" };
  const unsupported = Object.entries(flags)
    .filter(([name, value]) => !TUI_FLAGS.has(name) && isSet(value))
    .map(([name]) => FLAG_NAMES[name] ?? `--${name}`);
  // The TUI reads no config profile, so a profile from the environment would
  // be ignored just as silently as the flag.
  if (!isSet(flags["profile"]) && env["SEEKFORGE_PROFILE"]) unsupported.push("SEEKFORGE_PROFILE");
  if (unsupported.length > 0) return { kind: "repl", unsupported: [...new Set(unsupported)].sort() };
  const args: string[] = [];
  if (flags.continue === true) args.push("--continue");
  if (typeof flags.model === "string") args.push("--model", flags.model);
  return { kind: "tui", args };
}

/**
 * The TUI entry to load: the bundle beside this module in the published
 * package (`dist/tui.js`), else the workspace source when running from a
 * checkout under tsx. Undefined when neither exists.
 */
export function resolveTuiEntry(moduleUrl: string = import.meta.url): string | undefined {
  for (const relative of ["./tui.js", "../../tui/src/index.tsx"]) {
    const candidate = fileURLToPath(new URL(relative, moduleUrl));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Hands the terminal to the TUI. Its entry module starts on import and reads
 * its flags from process.argv, so argv is rewritten to what `seekforge-tui`
 * would have received. Resolves once the module has started, not when the TUI
 * exits; the process stays alive for as long as the TUI holds the terminal.
 */
export async function launchTui(entry: string, args: string[]): Promise<void> {
  process.argv = [process.argv[0] ?? process.execPath, entry, ...args];
  if (!/\.tsx?$/.test(entry)) {
    await import(pathToFileURL(entry).href);
    return;
  }
  // A checkout run under tsx compiles with the tsconfig of the current
  // directory, which has no `jsx` setting; the TUI needs its own. The
  // specifier is a runtime value so the published bundle never refers to tsx.
  const tsxApi = "tsx/esm/api";
  const { tsImport } = (await import(tsxApi)) as {
    tsImport: (specifier: string, options: { parentURL: string; tsconfig: string }) => Promise<unknown>;
  };
  await tsImport(pathToFileURL(entry).href, {
    parentURL: import.meta.url,
    tsconfig: join(dirname(entry), "..", "tsconfig.json"),
  });
}
