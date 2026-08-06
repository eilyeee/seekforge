import { createHash } from "node:crypto";
import { analyzeLoopStrategyIntelligence } from "./loop-strategy-intelligence.js";
import type { OrchestrationConfidence } from "./orchestration-intelligence.js";
import { isLoopFailureCategory } from "./loop-model-routing.js";
import { listLoopStates, type LoopState } from "./loop-state.js";
import { readOrchestrationControllerState } from "./orchestration-decisions.js";
import { compareByCodePoints } from "@seekforge/shared";

export type LoopRoutingContext = "node" | "rust" | "python" | "go" | "mixed" | "generic";

export type WorkspaceContextualLoopRoute = {
  context: LoopRoutingContext;
  failureCategory: string;
  model: string;
  attempts: number;
  improvements: number;
  regressions: number;
  meanUtility: number;
  decayedUtility: number;
  explorationScore: number;
  averageCostUsd: number;
  averageDurationMs: number;
  regressionRate: number;
  lastObservedAt: string;
  circuitOpen: boolean;
  confidence: OrchestrationConfidence;
};

export type WorkspaceContextualLoopRoutingProfile = {
  generatedAt: string;
  loops: number;
  samples: number;
  routes: WorkspaceContextualLoopRoute[];
};

export function loopRoutingContext(task: string, verifyCommand: string): LoopRoutingContext {
  const text = `${task}\n${verifyCommand}`.toLowerCase();
  const detected = [
    /\b(?:pnpm|npm|yarn|bun|node|typescript|javascript|vitest|jest)\b/.test(text) ? "node" : undefined,
    /\b(?:cargo|rustc|clippy|rust)\b/.test(text) ? "rust" : undefined,
    /\b(?:python|pytest|ruff|mypy|pip)\b/.test(text) ? "python" : undefined,
    /\b(?:go|golang)\b/.test(text) ? "go" : undefined,
  ].filter((item): item is Exclude<LoopRoutingContext, "mixed" | "generic"> => item !== undefined);
  return detected.length > 1 ? "mixed" : (detected[0] ?? "generic");
}

function confidence(attempts: number): OrchestrationConfidence {
  return attempts >= 20 ? "high" : attempts >= 8 ? "medium" : attempts >= 3 ? "low" : "none";
}

/** Aggregates only durable post-edit Loop evidence into local contextual arms. */
export function buildWorkspaceContextualLoopRoutingProfile(
  workspace: string,
  options: { now?: Date; halfLifeDays?: number; circuitBreakerRate?: number; circuitBreakerSamples?: number } = {},
): WorkspaceContextualLoopRoutingProfile {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Contextual Loop routing time is invalid");
  const halfLifeDays = options.halfLifeDays ?? 30;
  const circuitBreakerRate = options.circuitBreakerRate ?? 0.5;
  const circuitBreakerSamples = options.circuitBreakerSamples ?? 5;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays < 1 || halfLifeDays > 3650) {
    throw new RangeError("Contextual Loop routing halfLifeDays must be from 1 to 3650");
  }
  if (!Number.isFinite(circuitBreakerRate) || circuitBreakerRate < 0 || circuitBreakerRate > 1) {
    throw new RangeError("Contextual Loop routing circuitBreakerRate must be from 0 to 1");
  }
  if (!Number.isSafeInteger(circuitBreakerSamples) || circuitBreakerSamples < 1 || circuitBreakerSamples > 1000) {
    throw new RangeError("Contextual Loop routing circuitBreakerSamples must be from 1 to 1000");
  }
  const loops = listLoopStates(workspace).filter((loop) => loop.parentGraph === undefined);
  const aggregates = new Map<
    string,
    {
      context: LoopRoutingContext;
      failureCategory: string;
      model: string;
      attempts: number;
      improvements: number;
      regressions: number;
      weightedUtility: number;
      weightedCost: number;
      weightedDuration: number;
      effectiveAttempts: number;
      lastObservedAt: string;
    }
  >();
  for (const loop of loops) {
    const context = loopRoutingContext(loop.task, loop.verifyCommand);
    for (const route of analyzeLoopStrategyIntelligence(loop).routes) {
      if (!isLoopFailureCategory(route.failureCategory)) continue;
      const key = `${context}\0${route.failureCategory}\0${route.model}`;
      const current = aggregates.get(key) ?? {
        context,
        failureCategory: route.failureCategory,
        model: route.model,
        attempts: 0,
        improvements: 0,
        regressions: 0,
        weightedUtility: 0,
        weightedCost: 0,
        weightedDuration: 0,
        effectiveAttempts: 0,
        lastObservedAt: loop.updatedAt,
      };
      const ageDays = Math.max(0, nowMs - Date.parse(loop.updatedAt)) / (24 * 60 * 60_000);
      const recencyWeight = 2 ** (-ageDays / halfLifeDays);
      current.attempts += route.attempts;
      current.improvements += route.improvements;
      current.regressions += route.regressions;
      current.weightedUtility += route.utilityScore * route.attempts * recencyWeight;
      current.weightedCost += route.averageCostUsd * route.attempts * recencyWeight;
      current.weightedDuration += route.averageDurationMs * route.attempts * recencyWeight;
      current.effectiveAttempts += route.attempts * recencyWeight;
      if (Date.parse(loop.updatedAt) > Date.parse(current.lastObservedAt)) current.lastObservedAt = loop.updatedAt;
      aggregates.set(key, current);
    }
  }
  const totals = new Map<string, number>();
  for (const route of aggregates.values()) {
    const key = `${route.context}\0${route.failureCategory}`;
    totals.set(key, (totals.get(key) ?? 0) + route.attempts);
  }
  const routes = [...aggregates.values()]
    .map((route): WorkspaceContextualLoopRoute => {
      const total = totals.get(`${route.context}\0${route.failureCategory}`) ?? route.attempts;
      const meanUtility = route.effectiveAttempts === 0 ? 0 : route.weightedUtility / route.effectiveAttempts;
      const explorationBonus = Math.sqrt((2 * Math.log(Math.max(2, total))) / Math.max(1, route.attempts));
      const regressionRate = route.attempts === 0 ? 0 : route.regressions / route.attempts;
      return {
        context: route.context,
        failureCategory: route.failureCategory,
        model: route.model,
        attempts: route.attempts,
        improvements: route.improvements,
        regressions: route.regressions,
        meanUtility,
        decayedUtility: meanUtility,
        explorationScore: meanUtility + explorationBonus,
        averageCostUsd: route.effectiveAttempts === 0 ? 0 : route.weightedCost / route.effectiveAttempts,
        averageDurationMs: route.effectiveAttempts === 0 ? 0 : route.weightedDuration / route.effectiveAttempts,
        regressionRate,
        lastObservedAt: route.lastObservedAt,
        circuitOpen: route.attempts >= circuitBreakerSamples && regressionRate >= circuitBreakerRate,
        confidence: confidence(route.attempts),
      };
    })
    .sort(
      (left, right) =>
        compareByCodePoints(left.context, right.context) ||
        compareByCodePoints(left.failureCategory, right.failureCategory) ||
        right.explorationScore - left.explorationScore ||
        compareByCodePoints(left.model, right.model),
    );
  return {
    generatedAt: now.toISOString(),
    loops: loops.length,
    samples: routes.reduce((sum, route) => sum + route.attempts, 0),
    routes,
  };
}

/** Selects bounded explore/exploit arms; explicit caller routes remain authoritative. */
export function selectWorkspaceContextualLoopRoutes(
  workspace: string,
  input: Pick<LoopState, "loopId" | "task" | "verifyCommand">,
  options: {
    availableModels?: ReadonlySet<string>;
    minimumSamples?: number;
    explorationRate?: number;
    halfLifeDays?: number;
    circuitBreakerRate?: number;
    circuitBreakerSamples?: number;
    objectiveWeights?: { quality: number; cost: number; speed: number };
    now?: Date;
  } = {},
): Record<string, string> {
  const minimumSamples = options.minimumSamples ?? 3;
  const explorationRate = options.explorationRate ?? 0.1;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 1_000) {
    throw new RangeError("Contextual Loop routing minimumSamples must be from 1 to 1000");
  }
  if (!Number.isFinite(explorationRate) || explorationRate < 0 || explorationRate > 1) {
    throw new RangeError("Contextual Loop routing explorationRate must be from 0 to 1");
  }
  const weights = options.objectiveWeights ?? { quality: 0.7, cost: 0.15, speed: 0.15 };
  if (
    Object.values(weights).some((weight) => !Number.isFinite(weight) || weight < 0 || weight > 1) ||
    weights.quality + weights.cost + weights.speed <= 0
  ) {
    throw new RangeError("Contextual Loop routing objective weights must be finite from 0 to 1 with a positive sum");
  }
  if (readOrchestrationControllerState(workspace).mode === "frozen") return {};
  const context = loopRoutingContext(input.task, input.verifyCommand);
  const profile = buildWorkspaceContextualLoopRoutingProfile(workspace, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.halfLifeDays !== undefined ? { halfLifeDays: options.halfLifeDays } : {}),
    ...(options.circuitBreakerRate !== undefined ? { circuitBreakerRate: options.circuitBreakerRate } : {}),
    ...(options.circuitBreakerSamples !== undefined ? { circuitBreakerSamples: options.circuitBreakerSamples } : {}),
  });
  const grouped = new Map<string, WorkspaceContextualLoopRoute[]>();
  for (const route of profile.routes) {
    if (
      route.context !== context ||
      route.attempts < minimumSamples ||
      route.circuitOpen ||
      (options.availableModels && !options.availableModels.has(route.model))
    ) {
      continue;
    }
    const routes = grouped.get(route.failureCategory) ?? [];
    routes.push(route);
    grouped.set(route.failureCategory, routes);
  }
  return Object.fromEntries(
    [...grouped.entries()].flatMap(([category, routes]) => {
      const digest = createHash("sha256").update(`${input.loopId}\0${context}\0${category}`).digest();
      const explore = digest.readUInt32BE(0) / 0xffffffff < explorationRate;
      const objective = (route: WorkspaceContextualLoopRoute): number =>
        route.decayedUtility * weights.quality -
        Math.min(1, route.averageCostUsd) * weights.cost -
        Math.min(1, route.averageDurationMs / 60_000) * weights.speed;
      const ranked = [...routes].sort(
        (left, right) =>
          (explore
            ? objective(right) +
              (right.explorationScore - right.meanUtility) -
              (objective(left) + (left.explorationScore - left.meanUtility))
            : objective(right) - objective(left)) ||
          right.attempts - left.attempts ||
          compareByCodePoints(left.model, right.model),
      );
      return ranked[0] ? [[category, ranked[0].model]] : [];
    }),
  );
}
