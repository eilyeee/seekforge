// `--debug [filter]`: internal detail on stderr, built from streams that
// already exist — the agent's own event stream (provider retries, tool calls,
// permission prompts, context compaction, hook notices, subagents) plus the
// CLI's setup steps (config, MCP servers, sessions, worktrees, structured
// output). stdout is never touched, so machine formats stay parseable.
//
// Filter: comma-separated categories; `!name` excludes one. `--debug` alone
// (or an empty filter) shows everything; "api,tool" shows only those two;
// "!command" shows everything but live command output.

import type { AgentEvent } from "@seekforge/shared";

export const DEBUG_CATEGORIES = [
  "api",
  "command",
  "config",
  "context",
  "file",
  "hooks",
  "mcp",
  "model",
  "permission",
  "session",
  "step",
  "structured",
  "subagent",
  "tool",
  "usage",
  "worktree",
] as const;

export type DebugCategory = (typeof DEBUG_CATEGORIES)[number];

export type DebugFilter = { include?: Set<string>; exclude: Set<string> };

const MAX_LINE_CHARS = 600;

/** `undefined`/`false` → off (null); `true`/"" → everything; otherwise the parsed list. */
export function parseDebugFilter(value: boolean | string | undefined): DebugFilter | null {
  if (value === undefined || value === false) return null;
  if (value === true) return { exclude: new Set() };
  const include = new Set<string>();
  const exclude = new Set<string>();
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase();
    if (token === "") continue;
    if (token.startsWith("!")) {
      const name = token.slice(1).trim();
      if (name) exclude.add(name);
    } else {
      include.add(token);
    }
  }
  return include.size > 0 ? { include, exclude } : { exclude };
}

export function debugCategoryEnabled(filter: DebugFilter | null, category: string): boolean {
  if (!filter) return false;
  if (filter.exclude.has(category)) return false;
  return filter.include === undefined || filter.include.has(category);
}

/** Which category an agent event is reported under. */
export function debugCategoryOf(event: AgentEvent): DebugCategory {
  switch (event.type) {
    case "provider.retry":
      return "api";
    case "usage.updated":
      return "usage";
    case "model.message":
      return "model";
    case "tool.started":
    case "tool.completed":
      return "tool";
    case "permission.required":
      return "permission";
    case "context.compacted":
    case "context.microcompacted":
    case "context.usage":
      return "context";
    case "file.changed":
      return "file";
    case "command.output":
      return "command";
    // Hook systemMessages reach the stream as notices.
    case "notice":
      return "hooks";
    case "step.started":
    case "step.completed":
      return "step";
    default:
      return event.type.startsWith("subagent.") ? "subagent" : "session";
  }
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_LINE_CHARS ? `${oneLine.slice(0, MAX_LINE_CHARS - 1)}…` : oneLine;
}

/** A one-line, size-bounded rendering of an event (its type plus its payload). */
export function describeDebugEvent(event: AgentEvent): string {
  const { type, ...rest } = event as AgentEvent & Record<string, unknown>;
  let payload: string;
  try {
    payload = JSON.stringify(rest) ?? "";
  } catch {
    payload = "[unserializable]";
  }
  return clip(`${type} ${payload === "{}" ? "" : payload}`);
}

export type DebugLogger = {
  enabled: (category: DebugCategory) => boolean;
  log: (category: DebugCategory, message: string) => void;
  event: (event: AgentEvent) => void;
};

const OFF: DebugLogger = { enabled: () => false, log: () => {}, event: () => {} };

export function createDebugLogger(
  value: boolean | string | undefined,
  write: (line: string) => void = (line) => process.stderr.write(line),
  now: () => Date = () => new Date(),
): DebugLogger {
  const filter = parseDebugFilter(value);
  if (!filter) return OFF;
  const enabled = (category: DebugCategory): boolean => debugCategoryEnabled(filter, category);
  const log = (category: DebugCategory, message: string): void => {
    if (enabled(category)) write(`[debug ${now().toISOString()} ${category}] ${clip(message)}\n`);
  };
  return { enabled, log, event: (event) => log(debugCategoryOf(event), describeDebugEvent(event)) };
}
