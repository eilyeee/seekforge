import { clipLine, formatCostUsd } from "@seekforge/shared/format";
import type { TokenUsage } from "@seekforge/shared";
import type { ApprovalSetting, ContextUsage } from "./model.js";

/** Compact thousands formatting: 1234 -> "1.2K". */
export function kfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** One-line token/cost summary (port of render.ts formatUsage). */
export function formatUsage(usage: TokenUsage): string {
  return (
    `Tokens: ${kfmt(usage.promptTokens)} prompt (${kfmt(usage.cacheHitTokens)} cache hit) / ` +
    `${kfmt(usage.completionTokens)} completion   Cost: ${formatCostUsd(usage.costUsd)}`
  );
}

/**
 * "2h 5m" / "3m 12s" / "45s" — whole seconds, two units max; for long spans
 * (uptime, session age). The sub-second variant for short spans lives in
 * render-helpers.ts as formatDurationPrecise.
 */
export function formatDurationCoarse(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Relative age like "2h ago" for ISO timestamps; "just now" under a minute,
 * then m/h/d/mo buckets. Invalid or future timestamps return "—" so callers
 * always have a printable column.
 */
export function relativeAge(iso: string, now: Date | number = Date.now()): string {
  const then = Date.parse(iso);
  const ref = typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(then) || then > ref) return "—";
  const seconds = Math.floor((ref - then) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Multi-line usage block for /usage — labeled prompt / completion / total /
 * cost rows with the cache-hit ratio, plus optional duration and turn count.
 * The one-line formatUsage stays for the status bar.
 */
export function formatUsageDetail(usage: TokenUsage, opts?: { durationMs?: number; turns?: number }): string[] {
  const hitRate = usage.promptTokens > 0 ? Math.round((usage.cacheHitTokens / usage.promptTokens) * 100) : 0;
  const lines = [
    `prompt      ${kfmt(usage.promptTokens)} tokens (${kfmt(usage.cacheHitTokens)} cache hit · ${hitRate}% hit rate)`,
    `completion  ${kfmt(usage.completionTokens)} tokens`,
    `total       ${kfmt(usage.promptTokens + usage.completionTokens)} tokens`,
    `cost        ${formatCostUsd(usage.costUsd)}`,
  ];
  if (opts?.durationMs !== undefined) lines.push(`duration    ${formatDurationCoarse(opts.durationMs)}`);
  if (opts?.turns !== undefined) lines.push(`turns       ${opts.turns}`);
  return lines;
}

/** Dimmed JSON arg preview for a tool row (port of render.ts summarizeArgs). */
export function summarizeArgs(args: unknown): string {
  const text = JSON.stringify(args) ?? "";
  return clipLine(text, 120);
}

/** Keep the end of streaming output without starting on a lone low surrogate. */
export function tailText(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

export type StatusBarModel = {
  model: string;
  context?: ContextUsage;
  usage: TokenUsage;
  running: boolean;
  /** Persistent approval mode; "confirm" is the default and stays silent. */
  approval?: ApprovalSetting;
  /** Running background tasks ("⚙ 2 bg"). */
  bgRunning?: number;
};

/**
 * The pieces shown on the status line above the composer. Returned as data so
 * it can be unit tested without rendering Ink.
 */
export type StatusBarParts = {
  model: string;
  /** "ctx 42%" or undefined when no turn has run yet. */
  context?: string;
  /** "$0.0123" cumulative cost. */
  cost: string;
  /** "1.2K tok" cumulative total (prompt + completion). */
  tokens: string;
  state: "working" | "idle";
  /** "auto-approve" / "plan mode" when not the default confirm mode. */
  approval?: string;
  /** "⚙ 2 bg" when background tasks are running. */
  bg?: string;
};

export function statusBarParts(m: StatusBarModel): StatusBarParts {
  const totalTokens = m.usage.promptTokens + m.usage.completionTokens;
  return {
    model: m.model,
    context: m.context ? `ctx ${m.context.percent}%` : undefined,
    cost: `${formatCostUsd(m.usage.costUsd)}`,
    tokens: `${kfmt(totalTokens)} tok`,
    state: m.running ? "working" : "idle",
    ...(m.approval === "auto" ? { approval: "auto-approve" } : {}),
    ...(m.approval === "acceptEdits" ? { approval: "accept-edits" } : {}),
    ...(m.approval === "plan" ? { approval: "plan mode" } : {}),
    ...(m.bgRunning && m.bgRunning > 0 ? { bg: `⚙ ${m.bgRunning} bg` } : {}),
  };
}

export const PLAN_GLYPH: Record<string, string> = {
  done: "☑",
  in_progress: "◐",
  pending: "☐",
};

export function planGlyph(status: string): string {
  return PLAN_GLYPH[status] ?? "☐";
}

/**
 * The label a plan step shows: its `activeForm` ("Running the tests") while it
 * is in progress, else the step itself. Sessions written before activeForm
 * existed have none and keep showing the step.
 */
export function planItemLabel(item: { step: string; status: string; activeForm?: string }): string {
  const active = item.status === "in_progress" && typeof item.activeForm === "string" ? item.activeForm.trim() : "";
  return active !== "" ? active : item.step;
}

/**
 * Core's subagent color names as terminal colors: Ink knows red, yellow,
 * green, blue and cyan by name; the other three need a stand-in.
 */
const AGENT_COLORS: Readonly<Record<string, string>> = {
  red: "red",
  orange: "#ff8700",
  yellow: "yellow",
  green: "green",
  blue: "blue",
  purple: "magenta",
  pink: "#ff87d7",
  cyan: "cyan",
};

/**
 * The Ink color for a subagent definition's `color` (a name from core's closed
 * set, or `#rgb` / `#rrggbb`); undefined for anything else, so an unexpected
 * value renders in the default color instead of reaching the terminal.
 */
export function agentColor(color: string | undefined): string | undefined {
  if (color === undefined) return undefined;
  const value = color.trim().toLowerCase();
  if (Object.hasOwn(AGENT_COLORS, value)) return AGENT_COLORS[value];
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(value) ? value : undefined;
}

/**
 * Text someone else wrote (a model's progress report, a hook's message) as one
 * inert line: control characters — terminal escape sequences included — become
 * spaces, whitespace collapses, and the result is clipped to `max` characters.
 */
export function inertLine(text: string, max: number): string {
  const flat = stripControls(text).replace(/\s+/g, " ").trim();
  return clipLine(flat, max);
}

/**
 * `text` with every C0/C1 control character (terminal escape sequences
 * included) turned into a space, leaving layout such as leading indentation
 * alone. For lines that already are one line but may carry text a repository
 * or a server chose (an MCP server's name, command or error).
 */
export function stripControls(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}
