import { formatCostUsd } from "@seekforge/shared/format";
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
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
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
