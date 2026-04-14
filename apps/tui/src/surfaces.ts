import type { AgentDefinition, McpServerConfig, SessionMeta, ToolSpec } from "@seekforge/core";
import { kfmt } from "./format.js";
import type { BgTask } from "./model.js";

/**
 * Pure list/formatting helpers for the batch-C slash commands
 * (/sessions, /tasks, /agents, /mcp) and the /context overlay gauge.
 * Every formatter returns ready-to-print lines the app dispatches as dim
 * notices, so they stay unit-testable without rendering Ink.
 */

/** Collapses all whitespace runs (incl. newlines) and caps to `max` chars with an ellipsis. */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * One line per session, newest first as given:
 * "id  [status]  $0.0123  task…" (task collapsed to 60 chars).
 * Sessions without recorded usage show "—" in the cost column.
 */
export function formatSessionLines(metas: readonly SessionMeta[], limit = 15): string[] {
  if (metas.length === 0) return ["no sessions yet"];
  return metas.slice(0, limit).map((m) => {
    const cost = m.usage ? `$${m.usage.costUsd.toFixed(4)}` : "—";
    return `${m.id}  [${m.status}]  ${cost}  ${collapse(m.task, 60)}`;
  });
}

/**
 * One line per background task: "⚙ bg-1  running  npm run dev".
 * BgTask carries no start timestamp, so no duration column is shown.
 */
export function formatBgTaskLines(tasks: readonly BgTask[]): string[] {
  if (tasks.length === 0) return ["no background tasks this session"];
  return tasks.map((t) => `⚙ ${t.id}  ${t.status.padEnd(7)}  ${collapse(t.command, 60)}`);
}

/**
 * One line per dispatchable agent: "id  (mode)  description…", with
 * "[builtin]" appended for agents shipped with SeekForge.
 */
export function formatAgentLines(defs: readonly AgentDefinition[]): string[] {
  if (defs.length === 0) return ["no agents available"];
  return defs.map((d) => {
    const builtin = d.scope === "builtin" ? "  [builtin]" : "";
    return `${d.id}  (${d.mode})  ${collapse(d.description, 60)}${builtin}`;
  });
}

/** Matches dispatcher names produced by loadMcpToolSpecs: mcp__<server>__<tool>. */
const MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * One line per configured MCP server — "name  N tools (a, b, …)" listing up
 * to 5 tool names — plus a final total line. Tools are grouped by parsing the
 * `mcp__<server>__<tool>` spec names.
 */
export function formatMcpLines(
  servers: Record<string, McpServerConfig> | undefined,
  specs: readonly ToolSpec[],
): string[] {
  const names = Object.keys(servers ?? {});
  if (names.length === 0) return ["no MCP servers configured"];

  const byServer = new Map<string, string[]>(names.map((n) => [n, []]));
  for (const spec of specs) {
    const match = MCP_TOOL_NAME.exec(spec.name);
    if (!match) continue;
    byServer.get(match[1] as string)?.push(match[2] as string);
  }

  let total = 0;
  const lines = names.map((name) => {
    const tools = byServer.get(name) ?? [];
    total += tools.length;
    const count = `${tools.length} ${tools.length === 1 ? "tool" : "tools"}`;
    if (tools.length === 0) return `${name}  ${count}`;
    const preview = tools.slice(0, 5).join(", ") + (tools.length > 5 ? ", …" : "");
    return `${name}  ${count} (${preview})`;
  });
  lines.push(`total: ${total} ${total === 1 ? "tool" : "tools"} from ${names.length} ${names.length === 1 ? "server" : "servers"}`);
  return lines;
}

/**
 * A bar gauge for the context inspector, e.g. "███████░░░░░░░░░░░░░░░░░ 28%".
 * Percent is clamped to [0, 100]; width defaults to 24 columns.
 */
export function gauge(percent: number, width = 24): string {
  const p = Math.min(100, Math.max(0, Math.round(percent)));
  const filled = Math.round((p / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)} ${p}%`;
}

/** "usedK of budgetK tokens" companion text for the context gauge. */
export function gaugeCaption(usedTokens: number, budgetTokens: number): string {
  return `${kfmt(usedTokens)} of ${kfmt(budgetTokens)} tokens`;
}
