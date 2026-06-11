/**
 * Custom user-defined slash commands: Markdown files that become invocable
 * commands in the desktop/TUI. Two layers:
 *   project  <workspace>/.seekforge/commands/*.md   (scope "project")
 *   user     ~/.seekforge/commands/*.md             (scope "user")
 *
 * The user layer honors SEEKFORGE_HOME via seekforgeHome() so tests stay
 * deterministic. A name (filename without .md) defined in both layers resolves
 * to the project copy (project wins). Never throws — unreadable dirs/files
 * are skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seekforgeHome } from "../memory/store.js";

export type UserCommand = {
  /** Filename without the .md extension. */
  name: string;
  /** First non-empty line of the file, or "". */
  description: string;
  scope: "project" | "user";
  /** Full file contents. */
  body: string;
};

/** Reads one commands directory; unreadable dir or files are skipped. */
function loadCommandsDir(dir: string, scope: "project" | "user"): UserCommand[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: UserCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = entry.name.slice(0, -3);
    if (name === "") continue;
    let body: string;
    try {
      body = readFileSync(join(dir, entry.name), "utf8");
    } catch {
      continue;
    }
    const description = body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
    out.push({ name, description, scope, body });
  }
  return out;
}

/**
 * Loads custom slash commands from the project and user layers. Project
 * commands shadow user commands on a name clash (de-dup by name, project
 * wins). Returns project commands first, then the user-only commands.
 */
export function loadUserCommands(workspace: string): UserCommand[] {
  const project = loadCommandsDir(join(workspace, ".seekforge", "commands"), "project");
  const user = loadCommandsDir(join(seekforgeHome(), ".seekforge", "commands"), "user");
  const seen = new Set(project.map((c) => c.name));
  const out = [...project];
  for (const cmd of user) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

/** The placeholder a command body uses to interpolate the invocation arguments. */
export const COMMAND_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/** True when the command body interpolates arguments (so callers can prompt). */
export function commandTakesArguments(command: Pick<UserCommand, "body">): boolean {
  return command.body.includes(COMMAND_ARGUMENTS_PLACEHOLDER);
}

/**
 * Expands a custom command into the prompt to send. `$ARGUMENTS` (every
 * occurrence) is replaced with `args`; if the body has no placeholder, non-empty
 * args are appended as an "Arguments:" line. Matches the TUI behavior so the
 * CLI/desktop/TUI all expand identically.
 */
export function expandUserCommand(command: Pick<UserCommand, "body">, args: string): string {
  if (command.body.includes(COMMAND_ARGUMENTS_PLACEHOLDER)) {
    return command.body.split(COMMAND_ARGUMENTS_PLACEHOLDER).join(args);
  }
  return args === "" ? command.body : `${command.body}\n\nArguments: ${args}`;
}
