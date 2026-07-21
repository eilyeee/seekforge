/**
 * User-defined slash commands, the .claude/commands analog: markdown files
 * under <workspace>/.seekforge/commands/ and ~/.seekforge/commands/ become
 * palette entries. Project commands win on a name clash. Each file may open
 * with a YAML frontmatter block (--- fences) carrying a `description:`;
 * the rest is the prompt body, with "$ARGUMENTS" expanded at invoke time.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_COMMAND_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";

const DESCRIPTION_CAP = 60;
const ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

export type CustomCommand = {
  /** Sanitized command name (lowercase [a-z0-9-]), without the slash. */
  name: string;
  /** Frontmatter description, or the first body line capped at 60 chars. */
  description: string;
  /** Prompt body (frontmatter stripped). */
  body: string;
  scope: "project" | "global";
};

/** Sanitizes a filename stem into a command name: lowercase [a-z0-9-]. */
function sanitizeName(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Splits optional `---` frontmatter from the body; extracts description. */
function parseCommandFile(raw: string): { description: string; body: string } {
  const lines = raw.split(/\r?\n/);
  let description = "";
  let bodyLines = lines;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const line of lines.slice(1, end)) {
        const match = /^description:\s*(.*)$/.exec(line);
        if (match) description = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
      }
      bodyLines = lines.slice(end + 1);
    }
  }
  const body = bodyLines.join("\n").trim();
  if (description === "") {
    const firstLine = body.split("\n")[0] ?? "";
    description = firstLine.length > DESCRIPTION_CAP ? `${firstLine.slice(0, DESCRIPTION_CAP - 1)}…` : firstLine;
  }
  return { description, body };
}

/** Reads one commands directory; unreadable dir or files → skipped. */
function loadDir(dir: string, scope: "project" | "global"): CustomCommand[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CustomCommand[] = [];
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const name = sanitizeName(entry.name.slice(0, -3));
    if (name === "") continue;
    let raw: string;
    try {
      raw = readTextFileBounded(path.join(dir, entry.name), MAX_COMMAND_FILE_BYTES);
    } catch {
      continue;
    }
    const { description, body } = parseCommandFile(raw);
    out.push({ name, description, body, scope });
  }
  return out;
}

/**
 * Loads custom commands from <workspace>/.seekforge/commands/*.md and
 * <homeDir>/.seekforge/commands/*.md (homeDir defaults to os.homedir(),
 * injectable for tests). Project commands shadow global ones on a name
 * clash. Missing directories yield []. Never throws.
 */
export function loadCustomCommands(workspace: string, homeDir?: string): CustomCommand[] {
  const home = homeDir ?? os.homedir();
  const project = loadDir(path.join(workspace, ".seekforge", "commands"), "project");
  const global = loadDir(path.join(home, ".seekforge", "commands"), "global");
  const seen = new Set(project.map((c) => c.name));
  const out = [...project];
  for (const cmd of global) {
    if (seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    out.push(cmd);
  }
  return out;
}

/**
 * Expands a custom command into the prompt to send. Every "$ARGUMENTS"
 * occurrence is replaced with `args`; when the body has no placeholder,
 * non-empty args are appended as "\n\nArguments: <args>".
 */
export function expandCustomCommand(cmd: CustomCommand, args: string): string {
  if (cmd.body.includes(ARGUMENTS_PLACEHOLDER)) {
    return cmd.body.split(ARGUMENTS_PLACEHOLDER).join(args);
  }
  return args === "" ? cmd.body : `${cmd.body}\n\nArguments: ${args}`;
}

/**
 * CommandSpec-compatible rows for the palette: args hint "[args]" when the
 * body takes $ARGUMENTS, summary prefixed "(custom) " so user commands are
 * distinguishable from built-ins.
 */
export function customCommandSpecs(
  cmds: readonly CustomCommand[],
): Array<{ name: string; args?: string; summary: string }> {
  return cmds.map((cmd) =>
    cmd.body.includes(ARGUMENTS_PLACEHOLDER)
      ? { name: cmd.name, args: "[args]", summary: `(custom) ${cmd.description}` }
      : { name: cmd.name, summary: `(custom) ${cmd.description}` },
  );
}
