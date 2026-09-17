/**
 * User-defined slash commands for the TUI — a thin adapter over core's
 * implementation (packages/core/src/agent/commands.ts), which the CLI REPL and
 * the server already use, so every surface reads the same files the same way:
 * `:` namespaces from subdirectories, `description` / `argument-hint` /
 * `model` / `allowed-tools` frontmatter, `$ARGUMENTS` and `$1`..`$9`, and
 * `` !`shell` `` injection when the user invokes the command.
 */

import {
  acquireWorkspaceSessionGuard,
  commandHasShellInjection,
  commandTakesArguments,
  expandShellInjections,
  expandUserCommand,
  loadUserCommands,
  SessionBusyError,
  type PluginContributions,
  type UserCommand,
} from "@seekforge/core";
import { isBuiltinCommandName } from "./commands.js";
import { captureShellOutput } from "./shell-command.js";

export type CustomCommand = UserCommand;

/**
 * Project commands first, then user-only ones, then the enabled plugins'
 * `<plugin>:<command>` ones (the first layer wins on a clash). A file named
 * like a built-in is left out: built-ins keep their names, so a checked-out
 * repository cannot turn `/approve` into its own prompt. `contributions` is the
 * session's plugin snapshot, so commands match the skills and hooks it loaded.
 */
export function loadCustomCommands(workspace: string, contributions?: PluginContributions): CustomCommand[] {
  return loadUserCommands(workspace, contributions).filter((command) => !isBuiltinCommandName(command.name));
}

/**
 * Palette/help rows: the frontmatter `argument-hint` (or "[args]" when the body
 * interpolates arguments) and a "(custom)" prefix so user commands are
 * distinguishable from built-ins.
 */
export function customCommandSpecs(
  cmds: readonly CustomCommand[],
): Array<{ name: string; args?: string; summary: string }> {
  return cmds.map((cmd) => {
    const args = cmd.argumentHint ?? (commandTakesArguments(cmd) ? "[args]" : undefined);
    return { name: cmd.name, ...(args ? { args } : {}), summary: `(custom) ${cmd.description}` };
  });
}

/**
 * The command a typed `/head` names: the exact file name first (core names keep
 * their case), else the only case-insensitive match — the composer lowercases
 * nothing, but the palette and muscle memory often do.
 */
export function findCustomCommand(cmds: readonly CustomCommand[], head: string): CustomCommand | undefined {
  const exact = cmds.find((c) => c.name === head);
  if (exact) return exact;
  const folded = cmds.filter((c) => c.name.toLowerCase() === head.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

/** What a custom command invocation runs: the prompt plus its per-run overrides. */
export type PreparedCommand = {
  task: string;
  model?: string;
  allowedTools?: string[];
};

export class CommandWorkspaceBusyError extends Error {
  constructor() {
    super("another SeekForge run owns this workspace — shell injections wait until it finishes");
    this.name = "CommandWorkspaceBusyError";
  }
}

/**
 * Expands a command for one invocation. Shell injections run in the workspace
 * under the workspace session guard — the same rule the server applies to
 * `POST /api/commands/expand` — so they never race an active agent run; the
 * guard is released before the task itself starts.
 */
export async function prepareCustomCommand(
  cmd: CustomCommand,
  args: string,
  workspace: string,
  exec: (command: string, cwd: string) => Promise<string> = captureShellOutput,
): Promise<PreparedCommand> {
  let task = expandUserCommand(cmd, args);
  if (commandHasShellInjection(task)) {
    let guard: { release: () => void };
    try {
      guard = acquireWorkspaceSessionGuard(workspace);
    } catch (error) {
      if (error instanceof SessionBusyError) throw new CommandWorkspaceBusyError();
      throw error;
    }
    try {
      task = await expandShellInjections(task, (command) => exec(command, workspace));
    } finally {
      guard.release();
    }
  }
  return {
    task,
    ...(cmd.model ? { model: cmd.model } : {}),
    ...(cmd.allowedTools ? { allowedTools: [...cmd.allowedTools] } : {}),
  };
}
