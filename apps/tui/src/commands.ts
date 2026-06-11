/** Slash-command parsing for the composer. Pure + unit tested. */

export type SlashCommand =
  | { name: "help" }
  | { name: "new" }
  | { name: "context" }
  | { name: "usage" }
  | { name: "quit" }
  | { name: "model"; arg?: string }
  | { name: "unknown"; raw: string };

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "slash"; command: SlashCommand }
  | { kind: "task"; text: string };

const KNOWN = new Set(["help", "new", "context", "usage", "quit", "exit", "model"]);

export function parseInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!trimmed.startsWith("/")) return { kind: "task", text: trimmed };

  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  const name = (head ?? "").toLowerCase();
  if (!KNOWN.has(name)) return { kind: "slash", command: { name: "unknown", raw: trimmed } };

  switch (name) {
    case "help":
      return { kind: "slash", command: { name: "help" } };
    case "new":
      return { kind: "slash", command: { name: "new" } };
    case "context":
      return { kind: "slash", command: { name: "context" } };
    case "usage":
      return { kind: "slash", command: { name: "usage" } };
    case "quit":
    case "exit":
      return { kind: "slash", command: { name: "quit" } };
    case "model":
      return { kind: "slash", command: { name: "model", arg: rest[0] } };
    default:
      return { kind: "slash", command: { name: "unknown", raw: trimmed } };
  }
}

export const HELP_LINES: ReadonlyArray<[string, string]> = [
  ["/help", "show this help"],
  ["/new", "start a fresh session (next message opens it)"],
  ["/model <name>", "switch model for subsequent messages"],
  ["/context", "context-window occupancy of the last turn"],
  ["/usage", "cumulative token usage and cost"],
  ["/quit", "exit (Ctrl+C twice also works)"],
];
