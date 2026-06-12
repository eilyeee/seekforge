/**
 * Custom user-defined slash commands: Markdown files that become invocable
 * commands in the desktop/TUI. Two layers:
 *   project  <workspace>/.seekforge/commands/*.md   (scope "project")
 *   user     ~/.seekforge/commands/*.md             (scope "user")
 *
 * Subdirectories namespace the command: `frontend/build.md` becomes the command
 * `frontend:build` (path separators → ":"), matching Claude Code.
 *
 * The user layer honors SEEKFORGE_HOME via seekforgeHome() so tests stay
 * deterministic. A name defined in both layers resolves to the project copy
 * (project wins). Never throws — unreadable dirs/files are skipped.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { seekforgeHome } from "../memory/store.js";
import { parseFrontmatter } from "../subagents/frontmatter.js";

export type UserCommand = {
  /** Filename without the .md extension. */
  name: string;
  /** Frontmatter `description`, else the first non-empty body line, else "". */
  description: string;
  scope: "project" | "user";
  /** File contents with any YAML frontmatter stripped. */
  body: string;
  /** Frontmatter `model`: run this command with a specific model. */
  model?: string;
  /** Frontmatter `allowed-tools`: restrict the run to these tool names. */
  allowedTools?: string[];
  /** Frontmatter `argument-hint`: placeholder shown when prompting for args. */
  argumentHint?: string;
};

/**
 * Parses one command file. An optional YAML frontmatter block contributes
 * `description` / `model` / `allowed-tools` / `argument-hint` and is stripped
 * from the body; without it the whole file is the body and the description is
 * its first non-empty line. Malformed frontmatter falls back to the raw file.
 */
function parseCommandFile(name: string, scope: "project" | "user", raw: string): UserCommand {
  let body = raw;
  let description = "";
  let model: string | undefined;
  let allowedTools: string[] | undefined;
  let argumentHint: string | undefined;

  if (/^---\r?\n/.test(raw)) {
    try {
      const parsed = parseFrontmatter(raw);
      body = parsed.body;
      description = parsed.fields.get("description") ?? "";
      model = parsed.fields.get("model") || undefined;
      argumentHint = parsed.fields.get("argument-hint") || undefined;
      const tools = parsed.fields.get("allowed-tools");
      if (tools) {
        const list = tools
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (list.length > 0) allowedTools = list;
      }
    } catch {
      body = raw; // not a valid frontmatter block — treat the file as plain body
    }
  }

  if (description === "") {
    description = body.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
  }

  return {
    name,
    description,
    scope,
    body,
    ...(model ? { model } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(argumentHint ? { argumentHint } : {}),
  };
}

/**
 * Reads one commands directory recursively. Each `*.md` file becomes a command
 * whose name is its path under `root` with separators turned into ":"
 * (`frontend/build.md` → `frontend:build`). Unreadable dirs/files are skipped.
 */
function loadCommandsDir(root: string, scope: "project" | "user"): UserCommand[] {
  const out: UserCommand[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), `${prefix}${entry.name}:`);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const name = `${prefix}${entry.name.slice(0, -3)}`;
      if (name === "" || name.endsWith(":")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, entry.name), "utf8");
      } catch {
        continue;
      }
      out.push(parseCommandFile(name, scope, raw));
    }
  };
  walk(root, "");
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

/** The placeholder a command body uses to interpolate all invocation arguments. */
export const COMMAND_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

/** Matches a positional placeholder ($1 .. $9) in a command body. */
const POSITIONAL_PLACEHOLDER_RE = /\$([1-9])/;

/** True when the command body interpolates arguments (so callers can prompt). */
export function commandTakesArguments(command: Pick<UserCommand, "body">): boolean {
  return (
    command.body.includes(COMMAND_ARGUMENTS_PLACEHOLDER) || POSITIONAL_PLACEHOLDER_RE.test(command.body)
  );
}

/**
 * Expands a custom command into the prompt to send. Positional `$1`..`$9` are
 * replaced with the whitespace-split arguments; `$ARGUMENTS` (every occurrence)
 * with the full args string. If the body has no placeholder, non-empty args are
 * appended as an "Arguments:" line. Matches the TUI behavior so the
 * CLI/desktop/TUI all expand identically.
 */
export function expandUserCommand(command: Pick<UserCommand, "body">, args: string): string {
  if (!commandTakesArguments(command)) {
    return args === "" ? command.body : `${command.body}\n\nArguments: ${args}`;
  }
  const positional = args.trim() === "" ? [] : args.trim().split(/\s+/);
  return command.body
    .replace(/\$([1-9])/g, (_, d: string) => positional[Number(d) - 1] ?? "")
    .split(COMMAND_ARGUMENTS_PLACEHOLDER)
    .join(args);
}

/** Matches a shell injection in a command body: !`command`. */
const SHELL_INJECTION_RE = /!`([^`]+)`/;

/** True when the text embeds a `!`command`` shell injection. */
export function commandHasShellInjection(text: string): boolean {
  return SHELL_INJECTION_RE.test(text);
}

/**
 * Replaces every `` !`command` `` in `text` with the (trimmed) output of
 * `exec(command)`, matching Claude Code's command-body shell injection.
 * Commands run sequentially in source order; an exec rejection is rendered as
 * an inline `[command failed: …]` marker so one bad command never aborts the
 * whole expansion.
 */
export async function expandShellInjections(
  text: string,
  exec: (command: string) => Promise<string>,
): Promise<string> {
  const re = /!`([^`]+)`/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out += text.slice(last, m.index);
    try {
      out += (await exec(m[1] as string)).trim();
    } catch (err) {
      out += `[command failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
    last = re.lastIndex;
  }
  return out + text.slice(last);
}
