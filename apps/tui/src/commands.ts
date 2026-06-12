/**
 * Slash-command registry + parsing for the composer. Pure + unit tested.
 *
 * The registry drives the command palette (typing "/" lists COMMANDS with
 * descriptions; the palette filters them with fuzzy.ts) and /help. Adding a
 * command = one COMMANDS entry + one SlashCommand variant + a parseInput
 * case + a handler in app.tsx.
 */

export type CommandSpec = {
  /** Name without the leading slash, e.g. "plan". */
  name: string;
  /** Argument hint shown in the palette/help, e.g. "<task>". */
  args?: string;
  summary: string;
};

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  { name: "help", summary: "show all commands" },
  { name: "new", summary: "start a fresh session (next message opens it)" },
  { name: "sessions", summary: "list sessions of this project" },
  { name: "resume", args: "<id>", summary: "continue an existing session" },
  { name: "plan", args: "<task>", summary: "plan read-only first, confirm, then execute" },
  { name: "approve", args: "[auto|confirm|plan]", summary: "show or set the approval mode (Shift+Tab cycles)" },
  { name: "rewind", args: "[yes]", summary: "undo this session's file changes (dry-run first)" },
  { name: "model", args: "<name>", summary: "switch model for subsequent messages" },
  { name: "remember", args: "<fact>", summary: "save a fact to project memory (# <fact> also works)" },
  { name: "tasks", summary: "background tasks of the current session" },
  { name: "agents", summary: "list dispatchable subagents" },
  { name: "mcp", summary: "list configured MCP servers and their tools" },
  { name: "context", summary: "open the context inspector" },
  { name: "compact", summary: "how context compaction works" },
  { name: "usage", summary: "cumulative token usage and cost" },
  { name: "copy", summary: "copy the last assistant message to the clipboard" },
  { name: "editor", summary: "edit the prompt in $EDITOR (Ctrl+G)" },
  { name: "quit", summary: "exit (Ctrl+C twice also works)" },
];

export type SlashCommand =
  | { name: "help" }
  | { name: "new" }
  | { name: "sessions" }
  | { name: "resume"; arg?: string }
  | { name: "plan"; arg?: string }
  | { name: "approve"; arg?: string }
  | { name: "rewind"; arg?: string }
  | { name: "model"; arg?: string }
  | { name: "remember"; arg?: string }
  | { name: "tasks" }
  | { name: "agents" }
  | { name: "mcp" }
  | { name: "context" }
  | { name: "compact" }
  | { name: "usage" }
  | { name: "copy" }
  | { name: "editor" }
  | { name: "quit" }
  | { name: "unknown"; raw: string };

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "slash"; command: SlashCommand }
  | { kind: "task"; text: string };

const NO_ARG = new Set([
  "help",
  "new",
  "sessions",
  "tasks",
  "agents",
  "mcp",
  "context",
  "compact",
  "usage",
  "copy",
  "editor",
  "quit",
]);
/** Commands whose argument is the whole rest of the line (free text). */
const REST_ARG = new Set(["plan", "remember"]);
/** Commands taking a single word argument. */
const WORD_ARG = new Set(["resume", "approve", "rewind", "model"]);

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };

  // "# fact" is the inline-memory shorthand (Claude Code's # to remember).
  if (trimmed.startsWith("#")) {
    const fact = trimmed.slice(1).trim();
    if (fact === "") return { kind: "empty" };
    return { kind: "slash", command: { name: "remember", arg: fact } };
  }

  if (!trimmed.startsWith("/")) return { kind: "task", text: trimmed };

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const alias = name === "exit" ? "quit" : name;

  if (NO_ARG.has(alias)) return { kind: "slash", command: { name: alias } as SlashCommand };
  if (REST_ARG.has(alias)) {
    const arg = rest.join(" ").trim();
    return { kind: "slash", command: { name: alias, ...(arg ? { arg } : {}) } as SlashCommand };
  }
  if (WORD_ARG.has(alias)) {
    return { kind: "slash", command: { name: alias, ...(rest[0] ? { arg: rest[0] } : {}) } as SlashCommand };
  }
  return { kind: "slash", command: { name: "unknown", raw: trimmed } };
}

export const HELP_LINES: ReadonlyArray<[string, string]> = COMMANDS.map((c) => [
  c.args ? `/${c.name} ${c.args}` : `/${c.name}`,
  c.summary,
]);
