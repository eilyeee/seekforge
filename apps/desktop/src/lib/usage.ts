import type { TokenUsage } from "@seekforge/shared";

export function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
}

/** Accumulate TokenUsage reports (footer total across session.completed events). */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    costUsd: a.costUsd + b.costUsd,
  };
}

export function formatUsd(costUsd: number): string {
  return `$${costUsd.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
