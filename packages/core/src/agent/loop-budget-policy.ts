import type { LoopBudgetReason, LoopIterationSnapshot } from "./auto-loop.js";

export type LoopBudgetUsage = { costUsd: number; tokensUsed: number; elapsedMs: number; verifyRuns: number };
export type LoopBudgetLimits = {
  costBudgetUsd?: number;
  tokenBudget?: number;
  maxDurationMs?: number;
  maxVerifyRuns?: number;
};
export type LoopBudgetForecast = {
  samples: number;
  costUsd: number;
  tokensUsed: number;
  durationMs: number;
  verifyRuns: number;
};

/** Conservative next-iteration usage derived only from completed snapshots. */
export function forecastLoopBudgetUsage(snapshots: readonly LoopIterationSnapshot[]): LoopBudgetForecast {
  const recent = snapshots.filter((snapshot) => snapshot.iteration > 0).slice(-3);
  const conservative = (values: number[]): number => Math.max(...values.filter((value) => value > 0), 0);
  return {
    samples: recent.length,
    costUsd: conservative(recent.map((snapshot) => snapshot.costUsd ?? 0)),
    tokensUsed: conservative(recent.map((snapshot) => snapshot.tokensUsed ?? 0)),
    durationMs: conservative(recent.map((snapshot) => snapshot.durationMs ?? 0)),
    verifyRuns: conservative(
      recent.map((snapshot) =>
        snapshot.stageResults.reduce((total, stage) => Math.min(Number.MAX_SAFE_INTEGER, total + stage.attempts), 0),
      ),
    ),
  };
}

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
  const forecast = forecastLoopBudgetUsage(snapshots);
  if (forecast.samples === 0) return null;
  const forecastCost = forecast.costUsd;
  const forecastTokens = forecast.tokensUsed;
  const forecastDuration = forecast.durationMs;
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
  if (
    limits.maxVerifyRuns !== undefined &&
    forecast.verifyRuns > 0 &&
    usage.verifyRuns + forecast.verifyRuns >= limits.maxVerifyRuns
  ) {
    return "verify_runs";
  }
  return null;
}
