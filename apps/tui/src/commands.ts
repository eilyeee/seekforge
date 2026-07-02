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
  /** Help/palette grouping (see COMMAND_GROUPS order). */
  group: CommandGroup;
};

export type CommandGroup = "session" | "run" | "review" | "context" | "tools" | "settings" | "info";

/** Display order for grouped help. */
export const COMMAND_GROUPS: ReadonlyArray<[CommandGroup, string]> = [
  ["session", "Session"],
  ["run", "Running tasks"],
  ["review", "Review & history"],
  ["context", "Context & memory"],
  ["tools", "Tools & surfaces"],
  ["settings", "Settings"],
  ["info", "Info"],
];

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  { name: "help", summary: "show all commands" , group: "info" },
  { name: "new", summary: "start a fresh session (next message opens it)" , group: "session" },
  { name: "clear", args: "[name]", summary: "clear the transcript (name labels the old session)" , group: "session" },
  { name: "sessions", summary: "pick a session to resume (interactive)" , group: "session" },
  { name: "resume", args: "<id>", summary: "continue an existing session" , group: "session" },
  { name: "plan", args: "<task>", summary: "plan read-only first, confirm, then execute" , group: "run" },
  { name: "loop", args: "<verify command>", summary: "auto-loop: run→verify until the command passes (task = composer lines below)" , group: "run" },
  { name: "approve", args: "[auto|confirm|plan]", summary: "show or set the approval mode (Shift+Tab cycles)" , group: "run" },
  { name: "rewind", args: "[yes]", summary: "undo this session's file changes (dry-run first)" , group: "review" },
  { name: "backtrack", summary: "rewind the conversation to an earlier message (Esc Esc)" , group: "review" },
  { name: "fork", summary: "fork the current session (continue without touching the original)" , group: "session" },
  { name: "tab", args: "[new|close|next|<n>]", summary: "tabs: parallel sessions (Ctrl+N new, Ctrl+T cycle)", group: "session" },
  { name: "diff", summary: "git diff of the working tree" , group: "review" },
  { name: "review", summary: "review the uncommitted changes (read-only)" , group: "review" },
  { name: "todo", args: "[add <text> | done <n> | rm <n>]", summary: "cross-session todo list (.seekforge/todos.md)" , group: "context" },
  { name: "add-dir", args: "[path]", summary: "add a read-only directory for @ references" , group: "tools" },
  { name: "model", args: "<name>", summary: "switch model for subsequent messages" , group: "run" },
  { name: "think", args: "[on|off|high|max]", summary: "V4 thinking mode and reasoning effort" , group: "run" },
  { name: "remember", args: "<fact>", summary: "save a fact to project memory (# <fact> also works)" , group: "context" },
  { name: "memory", args: "[edit <file>]", summary: "list project memory facts (edit opens a memory file)" , group: "context" },
  { name: "tasks", args: "[kill <id>]", summary: "background tasks (live; kill stops one)" , group: "tools" },
  { name: "agents", summary: "list dispatchable subagents" , group: "tools" },
  { name: "skills", summary: "list installed skills and their status" , group: "tools" },
  { name: "mcp", summary: "list configured MCP servers and their tools" , group: "tools" },
  { name: "prompts", summary: "list MCP prompts (invoke as /mcp:<server>:<prompt>)" , group: "tools" },
  { name: "init", summary: "analyze the codebase and write/refresh AGENTS.md" , group: "tools" },
  { name: "doctor", summary: "diagnose the environment (key, node, git, runtime, mcp…)" , group: "info" },
  { name: "vim", summary: "toggle vim mode for the composer" , group: "settings" },
  { name: "mouse", summary: "toggle mouse-wheel scroll (off = native text selection)", group: "settings" },
  { name: "theme", args: "[preset]", summary: "switch the color theme (deepseek/mono/solarized/matrix…)", group: "settings" },
  { name: "terminal-setup", summary: "how to make Shift+Enter insert a newline in your terminal" , group: "settings" },
  { name: "context", summary: "open the context inspector" , group: "context" },
  { name: "compact", args: "[focus]", summary: "compact the session now (focus steers the LLM summary)" , group: "context" },
  { name: "usage", summary: "cumulative token usage and cost" , group: "context" },
  { name: "balance", summary: "DeepSeek account balance", group: "info" },
  { name: "export", args: "[path]", summary: "export the transcript as markdown" , group: "review" },
  { name: "handoff", args: "[list]", summary: "write a session handoff document for the next session", group: "review" },
  { name: "stash", args: "[pop|list]", summary: "stash / restore the composer draft", group: "session" },
  { name: "copy", summary: "copy the last assistant message to the clipboard" , group: "review" },
  { name: "editor", summary: "edit the prompt in $EDITOR (Ctrl+G)" , group: "settings" },
  { name: "quit", summary: "exit (Ctrl+C twice also works)" , group: "session" },
];

export type SlashCommand =
  | { name: "help" }
  | { name: "new" }
  | { name: "clear"; arg?: string }
  | { name: "sessions" }
  | { name: "resume"; arg?: string }
  | { name: "plan"; arg?: string }
  /** Auto-loop: `verify` is the success command; `task` is the composer text. */
  | { name: "loop"; verify?: string; task?: string }
  | { name: "approve"; arg?: string }
  | { name: "rewind"; arg?: string }
  | { name: "backtrack" }
  | { name: "fork" }
  | { name: "tab"; arg?: string }
  | { name: "diff" }
  | { name: "review" }
  | { name: "todo"; arg?: string }
  | { name: "add-dir"; arg?: string }
  | { name: "terminal-setup" }
  | { name: "model"; arg?: string }
  | { name: "think"; arg?: string }
  | { name: "remember"; arg?: string }
  | { name: "memory"; arg?: string }
  | { name: "tasks"; arg?: string }
  | { name: "agents" }
  | { name: "skills" }
  | { name: "mcp" }
  | { name: "prompts" }
  | { name: "init" }
  | { name: "doctor" }
  | { name: "vim" }
  | { name: "mouse" }
  | { name: "theme"; arg?: string }
  | { name: "balance" }
  | { name: "handoff"; arg?: string }
  | { name: "stash"; arg?: string }
  | { name: "context" }
  | { name: "compact"; arg?: string }
  | { name: "usage" }
  | { name: "export"; arg?: string }
  | { name: "copy" }
  | { name: "editor" }
  | { name: "status" }
  | { name: "config"; arg?: string }
  | { name: "permissions" }
  | { name: "hooks" }
  | { name: "release-notes" }
  | { name: "bug" }
  | { name: "quit" }
  | { name: "unknown"; raw: string };

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "slash"; command: SlashCommand }
  /** "!cmd" passthrough: run a shell command locally, outside the agent. */
  | { kind: "bash"; command: string }
  | { kind: "task"; text: string };

const NO_ARG = new Set([
  "help",
  "new",
  "sessions",
  "backtrack",
  "fork",
  "diff",
  "review",
  "terminal-setup",
  "agents",
  "skills",
  "mcp",
  "prompts",
  "init",
  "doctor",
  "vim",
  "mouse",
  "balance",
  "status",
  "permissions",
  "hooks",
  "release-notes",
  "bug",
  "context",
  "usage",
  "copy",
  "editor",
  "quit",
]);
/** Commands whose argument is the whole rest of the line (free text). */
const REST_ARG = new Set(["plan", "remember", "tasks", "todo", "add-dir", "clear", "compact", "memory"]);
/** Commands taking a single word argument. */
const WORD_ARG = new Set(["resume", "approve", "rewind", "model", "think", "export", "config", "tab", "theme", "handoff", "stash"]);

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };

  // "# fact" is the inline-memory shorthand (Claude Code's # to remember).
  if (trimmed.startsWith("#")) {
    const fact = trimmed.slice(1).trim();
    if (fact === "") return { kind: "empty" };
    return { kind: "slash", command: { name: "remember", arg: fact } };
  }

  // "!cmd" runs a local shell command directly (no agent, no permission flow:
  // the user typed it themselves in their own terminal).
  if (trimmed.startsWith("!")) {
    const command = trimmed.slice(1).trim();
    if (command === "") return { kind: "empty" };
    return { kind: "bash", command };
  }

  if (!trimmed.startsWith("/")) return { kind: "task", text: trimmed };

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  const ALIAS: Record<string, string> = { exit: "quit", q: "quit", h: "help", todos: "todo", cost: "usage" };
  const alias = ALIAS[name] ?? name;

  // /loop is multi-line: the first line carries the verify command, every line
  // below it is the task handed to the agent (so "the composer text is the
  // task"). Split on the first newline before the generic arg handling.
  if (alias === "loop") {
    const newlineIdx = trimmed.indexOf("\n");
    const firstLine = newlineIdx === -1 ? trimmed : trimmed.slice(0, newlineIdx);
    const task = newlineIdx === -1 ? "" : trimmed.slice(newlineIdx + 1).trim();
    const verify = firstLine.replace(/^\/\s*loop\s*/i, "").trim();
    return {
      kind: "slash",
      command: { name: "loop", ...(verify ? { verify } : {}), ...(task ? { task } : {}) },
    };
  }

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
