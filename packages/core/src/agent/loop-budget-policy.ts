import type { LoopBudgetReason, LoopIterationSnapshot } from "./auto-loop.js";

export type LoopBudgetUsage = { costUsd: number; tokensUsed: number; elapsedMs: number; verifyRuns: number };
export type LoopBudgetLimits = {
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  maxVerifyRuns?: number;
};

export function currentLoopBudgetReason(
  usage: LoopBudgetUsage,
  limits: LoopBudgetLimits,
  pending: { costUsd?: number; tokens?: number } = {},
): LoopBudgetReason | null {
  if (limits.costBudgetUsd !== undefined && usage.costUsd + (pending.costUsd ?? 0) >= limits.costBudgetUsd) {
    return "cost";
  }
  if (limits.tokenBudget !== undefined && usage.tokensUsed + (pending.tokens ?? 0) >= limits.tokenBudget) {
    return "tokens";
  }
  if (limits.maxDurationMs !== undefined && usage.elapsedMs >= limits.maxDurationMs) return "duration";
  if (limits.maxVerifyRuns !== undefined && usage.verifyRuns >= limits.maxVerifyRuns) return "verify_runs";
  return null;
}

export function forecastLoopBudgetReason(
  usage: LoopBudgetUsage,
  limits: LoopBudgetLimits,
  snapshots: readonly LoopIterationSnapshot[],
): LoopBudgetReason | null {
  const recent = snapshots.filter((snapshot) => snapshot.iteration > 0).slice(-3);
  if (recent.length === 0) return null;
  const conservative = (values: number[]): number => Math.max(...values.filter((value) => value > 0), 0);
  const forecastCost = conservative(recent.map((snapshot) => snapshot.costUsd ?? 0));
  const forecastTokens = conservative(recent.map((snapshot) => snapshot.tokensUsed ?? 0));
  const forecastDuration = conservative(recent.map((snapshot) => snapshot.durationMs ?? 0));
  if (limits.costBudgetUsd !== undefined && forecastCost > 0 && usage.costUsd + forecastCost >= limits.costBudgetUsd) {
    return "cost";
  }
  if (
    limits.tokenBudget !== undefined &&
    forecastTokens > 0 &&
    usage.tokensUsed + forecastTokens >= limits.tokenBudget
  ) {
    return "tokens";
  }
  if (
    limits.maxDurationMs !== undefined &&
    forecastDuration > 0 &&
    usage.elapsedMs + forecastDuration >= limits.maxDurationMs
  ) {
    return "duration";
  }
  return null;
}
