import { createHash } from "node:crypto";
import { analyzeLoopStrategyIntelligence } from "./loop-strategy-intelligence.js";
import type { OrchestrationConfidence } from "./orchestration-intelligence.js";
import { isLoopFailureCategory } from "./loop-model-routing.js";
import { listLoopStates, type LoopState } from "./loop-state.js";

export type LoopRoutingContext = "node" | "rust" | "python" | "go" | "mixed" | "generic";

export type WorkspaceContextualLoopRoute = {
  context: LoopRoutingContext;
  failureCategory: string;
  model: string;
  attempts: number;
  improvements: number;
  regressions: number;
  meanUtility: number;
  explorationScore: number;
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
export function buildWorkspaceContextualLoopRoutingProfile(workspace: string): WorkspaceContextualLoopRoutingProfile {
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
      };
      current.attempts += route.attempts;
      current.improvements += route.improvements;
      current.regressions += route.regressions;
      current.weightedUtility += route.utilityScore * route.attempts;
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
      const meanUtility = route.attempts === 0 ? 0 : route.weightedUtility / route.attempts;
      const explorationBonus = Math.sqrt((2 * Math.log(Math.max(2, total))) / Math.max(1, route.attempts));
      return {
        context: route.context,
        failureCategory: route.failureCategory,
        model: route.model,
        attempts: route.attempts,
        improvements: route.improvements,
        regressions: route.regressions,
        meanUtility,
        explorationScore: meanUtility + explorationBonus,
        confidence: confidence(route.attempts),
      };
    })
    .sort(
      (left, right) =>
        left.context.localeCompare(right.context) ||
        left.failureCategory.localeCompare(right.failureCategory) ||
        right.explorationScore - left.explorationScore ||
        left.model.localeCompare(right.model),
    );
  return {
    generatedAt: new Date().toISOString(),
    loops: loops.length,
    samples: routes.reduce((sum, route) => sum + route.attempts, 0),
    routes,
  };
}

/** Selects bounded explore/exploit arms; explicit caller routes remain authoritative. */
export function selectWorkspaceContextualLoopRoutes(
  workspace: string,
  input: Pick<LoopState, "loopId" | "task" | "verifyCommand">,
  options: { availableModels?: ReadonlySet<string>; minimumSamples?: number; explorationRate?: number } = {},
): Record<string, string> {
  const minimumSamples = options.minimumSamples ?? 3;
  const explorationRate = options.explorationRate ?? 0.1;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 1_000) {
    throw new RangeError("Contextual Loop routing minimumSamples must be from 1 to 1000");
  }
  if (!Number.isFinite(explorationRate) || explorationRate < 0 || explorationRate > 1) {
    throw new RangeError("Contextual Loop routing explorationRate must be from 0 to 1");
  }
  const context = loopRoutingContext(input.task, input.verifyCommand);
  const profile = buildWorkspaceContextualLoopRoutingProfile(workspace);
  const grouped = new Map<string, WorkspaceContextualLoopRoute[]>();
  for (const route of profile.routes) {
    if (
      route.context !== context ||
      route.attempts < minimumSamples ||
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
      const ranked = [...routes].sort(
        (left, right) =>
          (explore ? right.explorationScore - left.explorationScore : right.meanUtility - left.meanUtility) ||
          right.attempts - left.attempts ||
          left.model.localeCompare(right.model),
      );
      return ranked[0] ? [[category, ranked[0].model]] : [];
    }),
  );
}
