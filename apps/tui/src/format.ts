import type { TokenUsage } from "@seekforge/shared";
import type { ContextUsage } from "./model.js";

/** Compact thousands formatting: 1234 -> "1.2K". */
export function kfmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** One-line token/cost summary (port of render.ts formatUsage). */
export function formatUsage(usage: TokenUsage): string {
  return (
    `Tokens: ${kfmt(usage.promptTokens)} prompt (${kfmt(usage.cacheHitTokens)} cache hit) / ` +
    `${kfmt(usage.completionTokens)} completion   Cost: $${usage.costUsd.toFixed(4)}`
  );
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
  approval?: "auto" | "confirm" | "plan";
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
    cost: `$${m.usage.costUsd.toFixed(4)}`,
    tokens: `${kfmt(totalTokens)} tok`,
    state: m.running ? "working" : "idle",
    ...(m.approval === "auto" ? { approval: "auto-approve" } : {}),
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
