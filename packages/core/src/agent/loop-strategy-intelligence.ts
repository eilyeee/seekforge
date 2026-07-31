import type { LoopState } from "./loop-state.js";
import type { OrchestrationConfidence } from "./orchestration-intelligence.js";

export type LoopStrategyOutcome = {
  failureCategory: string;
  model: string;
  routeReason: string;
  attempts: number;
  improvements: number;
  regressions: number;
  improvementRate: number;
  regressionRate: number;
  qualityScore: number;
  utilityScore: number;
  lowerConfidenceBound: number;
  averageCostUsd: number;
  averageDurationMs: number;
  confidence: OrchestrationConfidence;
};

export type LoopStrategyIntelligenceReport = {
  loopId: string;
  samples: number;
  routes: LoopStrategyOutcome[];
  recommendedRoutes: Array<{
    failureCategory: string;
    model: string;
    confidence: OrchestrationConfidence;
    evidenceCount: number;
  }>;
};

type MutableRoute = Omit<
  LoopStrategyOutcome,
  | "improvementRate"
  | "regressionRate"
  | "qualityScore"
  | "utilityScore"
  | "lowerConfidenceBound"
  | "averageCostUsd"
  | "averageDurationMs"
  | "confidence"
> & {
  costUsd: number;
  durationMs: number;
  weightedQuality: number;
  recencyWeight: number;
};

function confidenceForSamples(samples: number): OrchestrationConfidence {
  if (samples <= 0) return "none";
  if (samples < 3) return "low";
  if (samples < 8) return "medium";
  return "high";
}

function wilsonLowerBound(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const proportion = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = proportion + (z * z) / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total);
  return Math.max(0, (center - margin) / denominator);
}

/** Learns only from post-edit snapshots; iteration zero is not an executed strategy. */
export function analyzeLoopStrategyIntelligence(state: LoopState): LoopStrategyIntelligenceReport {
  const snapshots = [...(state.snapshots ?? [])].sort((left, right) => left.iteration - right.iteration);
  const routes = new Map<string, MutableRoute>();
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index]!;
    if (snapshot.iteration <= 0 || !snapshot.editModel) continue;
    const previous = snapshots
      .slice(0, index)
      .reverse()
      .find((candidate) => candidate.iteration < snapshot.iteration);
    // The edit model is selected from the failure before the edit, not the post-edit category.
    const routedCategory = previous?.failureCategory;
    if (!routedCategory || routedCategory === "none") continue;
    const key = `${routedCategory}\0${snapshot.editModel}\0${snapshot.modelRouteReason ?? "default"}`;
    const route = routes.get(key) ?? {
      failureCategory: routedCategory,
      model: snapshot.editModel,
      routeReason: snapshot.modelRouteReason ?? "default",
      attempts: 0,
      improvements: 0,
      regressions: 0,
      costUsd: 0,
      durationMs: 0,
      weightedQuality: 0,
      recencyWeight: 0,
    };
    route.attempts += 1;
    route.costUsd += snapshot.costUsd ?? 0;
    route.durationMs += snapshot.durationMs ?? 0;
    const failureDelta = previous ? previous.failedTests - snapshot.failedTests : 0;
    if (snapshot.rolledBack || failureDelta < 0) route.regressions += 1;
    else if (failureDelta > 0) route.improvements += 1;
    const passRatio =
      snapshot.stageResults.length === 0
        ? snapshot.failureCategory === "none"
          ? 1
          : 0
        : snapshot.stageResults.filter((stage) => stage.code === 0).length / snapshot.stageResults.length;
    const flakePenalty = snapshot.stageResults.some((stage) => stage.flaky) ? 0.2 : 0;
    const progress = previous ? failureDelta / Math.max(1, previous.failedTests) : 0;
    const quality = Math.max(
      -1,
      Math.min(1, progress * 0.6 + passRatio * 0.4 - flakePenalty - (snapshot.rolledBack ? 1 : 0)),
    );
    const weight = index + 1;
    route.weightedQuality += quality * weight;
    route.recencyWeight += weight;
    routes.set(key, route);
  }
  const outcomes = [...routes.values()]
    .map(
      (route): LoopStrategyOutcome => ({
        failureCategory: route.failureCategory,
        model: route.model,
        routeReason: route.routeReason,
        attempts: route.attempts,
        improvements: route.improvements,
        regressions: route.regressions,
        improvementRate: route.attempts === 0 ? 0 : route.improvements / route.attempts,
        regressionRate: route.attempts === 0 ? 0 : route.regressions / route.attempts,
        qualityScore: route.recencyWeight === 0 ? 0 : route.weightedQuality / route.recencyWeight,
        utilityScore:
          route.recencyWeight === 0
            ? 0
            : route.weightedQuality /
              route.recencyWeight /
              (1 +
                (route.costUsd / Math.max(1, route.attempts)) * 10 +
                route.durationMs / Math.max(1, route.attempts) / 60_000),
        lowerConfidenceBound: wilsonLowerBound(route.improvements, route.attempts),
        averageCostUsd: route.attempts === 0 ? 0 : route.costUsd / route.attempts,
        averageDurationMs: route.attempts === 0 ? 0 : route.durationMs / route.attempts,
        confidence: confidenceForSamples(route.attempts),
      }),
    )
    .sort(
      (left, right) =>
        left.failureCategory.localeCompare(right.failureCategory) ||
        right.lowerConfidenceBound - left.lowerConfidenceBound ||
        right.utilityScore - left.utilityScore ||
        right.improvementRate - left.improvementRate ||
        right.attempts - left.attempts ||
        left.model.localeCompare(right.model),
    );
  const recommendedRoutes = [...new Set(outcomes.map((outcome) => outcome.failureCategory))].flatMap((category) => {
    const candidate = outcomes.find((outcome) => outcome.failureCategory === category && outcome.attempts >= 2);
    return candidate
      ? [
          {
            failureCategory: category,
            model: candidate.model,
            confidence: candidate.confidence,
            evidenceCount: candidate.attempts,
          },
        ]
      : [];
  });
  return {
    loopId: state.loopId,
    samples: outcomes.reduce((sum, route) => sum + route.attempts, 0),
    routes: outcomes,
    recommendedRoutes,
  };
}
