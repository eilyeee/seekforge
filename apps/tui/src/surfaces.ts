import type { AgentDefinition, McpServerConfig, SessionMeta, ToolSpec } from "@seekforge/core";
import { kfmt, relativeAge } from "./format.js";
import type { BgTask, ChatItem } from "./model.js";

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
 * "id  [status]  2h ago  $0.0123  task…" (task collapsed to 60 chars).
 * Sessions without recorded usage show "—" in the cost column; the age comes
 * from updatedAt relative to `now` (injectable for tests).
 */
export function formatSessionLines(
  metas: readonly SessionMeta[],
  limit = 15,
  now: Date | number = Date.now(),
): string[] {
  if (metas.length === 0) return ["no sessions yet"];
  return metas.slice(0, limit).map((m) => {
    const cost = m.usage ? `$${m.usage.costUsd.toFixed(4)}` : "—";
    return `${m.id}  [${m.status}]  ${relativeAge(m.updatedAt, now)}  ${cost}  ${collapse(m.task, 60)}`;
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

// ---------------------------------------------------------------------------
// /context per-category breakdown
// ---------------------------------------------------------------------------

/** One row of the /context breakdown: estimated tokens for a content category. */
export type ContextCategoryRow = {
  label: string;
  /** chars/4 token estimate over the category's text. */
  tokens: number;
  /** Item count in the category. */
  count: number;
  /** Share of the total estimate, 0–100 (rows sum to ~100). */
  percent: number;
};

/** chars/4 heuristic, mirroring core's estimateTokens (agent/context.ts). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Breakdown category for one transcript item, or null for ignorable items. */
function itemCategory(item: ChatItem): { label: string; text: string } | null {
  switch (item.kind) {
    case "user":
      return { label: "user messages", text: item.text };
    case "assistant":
      return { label: "assistant text", text: item.text };
    case "thinking":
      return { label: "thinking", text: item.text };
    case "tool":
      return {
        label: "tool results",
        text: `${item.toolName}${JSON.stringify(item.args) ?? ""}${item.resultPreview ?? ""}`,
      };
    case "diff":
      return { label: "diffs & files", text: item.lines.map((l) => l.text).join("\n") };
    case "file":
      return { label: "diffs & files", text: item.path };
    case "shell":
      return { label: "shell output", text: `${item.command}\n${item.output}` };
    case "plan":
      return { label: "plans & reports", text: item.items.map((p) => p.step).join("\n") };
    case "report":
      return { label: "plans & reports", text: JSON.stringify(item.report) ?? "" };
    default:
      // step titles and local notices never reach the model's context.
      return null;
  }
}

/**
 * Estimates how the transcript's content splits across categories (tool
 * results vs assistant text vs diffs/shell …) using the same chars/4
 * heuristic core uses for the window gauge. Rows are sorted by tokens
 * descending and zero-token categories are dropped; percents are shares of
 * the total estimate. An estimate, not billing data: local notices/steps are
 * excluded, and compaction may have already dropped old turns server-side.
 */
export function contextBreakdown(items: readonly ChatItem[]): ContextCategoryRow[] {
  const byLabel = new Map<string, { tokens: number; count: number }>();
  for (const item of items) {
    const cat = itemCategory(item);
    if (!cat) continue;
    const tokens = estimateTokens(cat.text);
    const row = byLabel.get(cat.label) ?? { tokens: 0, count: 0 };
    row.tokens += tokens;
    row.count += 1;
    byLabel.set(cat.label, row);
  }
  const total = [...byLabel.values()].reduce((sum, r) => sum + r.tokens, 0);
  return [...byLabel.entries()]
    .filter(([, r]) => r.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([label, r]) => ({
      label,
      tokens: r.tokens,
      count: r.count,
      percent: total > 0 ? Math.round((r.tokens / total) * 100) : 0,
    }));
}
