import { createHash } from "node:crypto";
import type { LoopIterationSnapshot } from "./auto-loop.js";
import type { EngineeringGraphDefinition } from "./graph-contract.js";
import { MAX_GRAPH_CONCURRENCY, MAX_GRAPH_RESOURCE_CAPACITIES, MAX_GRAPH_RESOURCE_CAPACITY } from "./graph-contract.js";
import type { GraphExecutionAdapter } from "./graph-engineering.js";
import type { EngineeringGraphHealthReport } from "./graph-health.js";
import { simulateEngineeringGraph } from "./graph-simulation.js";
import type { EngineeringGraphState } from "./graph-state.js";
import type { LoopHealthReport } from "./loop-health.js";
import type { LoopState } from "./loop-state.js";

export type OrchestrationConfidence = "none" | "low" | "medium" | "high";

export type OrchestrationSloPolicy = {
  maxP95DurationMs?: number;
  maxCostUsd?: number;
  maxFailureRate?: number;
  minForecastCoverage?: number;
};

export type OrchestrationSloEvaluation = {
  status: "unknown" | "met" | "at_risk" | "breached";
  objectives: Array<{
    kind: "p95_duration" | "cost" | "failure_rate" | "forecast_coverage";
    status: "unknown" | "met" | "at_risk" | "breached";
    observed?: number;
    target: number;
  }>;
};

export type OrchestrationProposalAction =
  | { kind: "graph_concurrency"; value: number }
  | { kind: "graph_resource_capacity"; resource: string; value: number }
  | { kind: "loop_route"; failureCategory: string; model: string }
  | { kind: "budget_review"; budget: string; forecastIterations: number }
  | { kind: "executor_placement"; nodeId: string; executor: string };

export type OrchestrationProposalDraft = {
  id: string;
  scope: "loop" | "graph";
  sourceId: string;
  sourceFingerprint: string;
  confidence: OrchestrationConfidence;
  evidenceCount: number;
  risk: "low" | "medium" | "high";
  title: string;
  rationale: string;
  action: OrchestrationProposalAction;
};

export type LoopStrategyOutcome = {
  failureCategory: string;
  model: string;
  routeReason: string;
  attempts: number;
  improvements: number;
  regressions: number;
  improvementRate: number;
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

export type EngineeringGraphOptimizationScenario = {
  id: string;
  changes: Array<
    | { kind: "max_concurrency"; from: number; to: number }
    | { kind: "resource_capacity"; resource: string; from: number; to: number }
  >;
  predictedMakespanMs: number;
  predictedActiveDurationMs: number;
  predictedSavingsMs: number;
  risks: string[];
  paretoOptimal: boolean;
};

export type EngineeringGraphPlacement = {
  nodeId: string;
  executor: string;
  status: "eligible" | "missing" | "untrusted" | "protocol_mismatch" | "cancellation_unsupported";
  reasons: string[];
};

export type EngineeringGraphOptimizationReport = {
  graphId: string;
  confidence: OrchestrationConfidence;
  evidenceCount: number;
  scenarios: EngineeringGraphOptimizationScenario[];
  placements: EngineeringGraphPlacement[];
  proposals: OrchestrationProposalDraft[];
};

export type OrchestrationPortfolioReport = {
  generatedAt: string;
  status: "healthy" | "warning" | "critical";
  totals: {
    loops: number;
    graphs: number;
    costUsd: number;
    tokensUsed: number;
    activeDurationMs: number;
    configuredCostBudgetUsd: number;
    configuredTokenBudget: number;
    configuredDurationBudgetMs: number;
  };
  items: Array<{
    kind: "loop" | "graph";
    id: string;
    status: string;
    costUsd: number;
    tokensUsed: number;
    activeDurationMs: number;
    parent?: { graphId: string; nodeId: string };
  }>;
};

function confidenceForSamples(samples: number): OrchestrationConfidence {
  if (samples <= 0) return "none";
  if (samples < 3) return "low";
  if (samples < 8) return "medium";
  return "high";
}

function proposalId(
  scope: OrchestrationProposalDraft["scope"],
  sourceId: string,
  sourceFingerprint: string,
  action: OrchestrationProposalAction,
): string {
  const digest = createHash("sha256")
    .update(`${scope}\0${sourceId}\0${sourceFingerprint}\0${JSON.stringify(action)}`)
    .digest("hex")
    .slice(0, 20);
  return `opt-${digest}`;
}

function validateSloPolicy(policy: OrchestrationSloPolicy): void {
  const finitePositive = (value: number | undefined): boolean =>
    value === undefined || (Number.isFinite(value) && value > 0);
  if (!finitePositive(policy.maxP95DurationMs) || !finitePositive(policy.maxCostUsd)) {
    throw new Error("SLO duration and cost targets must be finite positive numbers");
  }
  for (const value of [policy.maxFailureRate, policy.minForecastCoverage]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error("SLO rate targets must be finite numbers from 0 to 1");
    }
  }
}

function upperBoundObjective(
  kind: "p95_duration" | "cost" | "failure_rate",
  observed: number | undefined,
  target: number,
): OrchestrationSloEvaluation["objectives"][number] {
  if (observed === undefined) return { kind, status: "unknown", target };
  return {
    kind,
    observed,
    target,
    status: observed > target ? "breached" : target > 0 && observed >= target * 0.9 ? "at_risk" : "met",
  };
}

/** Evaluates advisory SLOs without changing runtime eligibility or hard budgets. */
export function evaluateOrchestrationSlo(
  observations: {
    p95DurationMs?: number;
    costUsd?: number;
    failureRate?: number;
    forecastCoverage?: number;
  },
  policy: OrchestrationSloPolicy,
): OrchestrationSloEvaluation {
  validateSloPolicy(policy);
  const objectives: OrchestrationSloEvaluation["objectives"] = [];
  if (policy.maxP95DurationMs !== undefined) {
    objectives.push(upperBoundObjective("p95_duration", observations.p95DurationMs, policy.maxP95DurationMs));
  }
  if (policy.maxCostUsd !== undefined) {
    objectives.push(upperBoundObjective("cost", observations.costUsd, policy.maxCostUsd));
  }
  if (policy.maxFailureRate !== undefined) {
    objectives.push(upperBoundObjective("failure_rate", observations.failureRate, policy.maxFailureRate));
  }
  if (policy.minForecastCoverage !== undefined) {
    const observed = observations.forecastCoverage;
    objectives.push(
      observed === undefined
        ? { kind: "forecast_coverage", status: "unknown", target: policy.minForecastCoverage }
        : {
            kind: "forecast_coverage",
            observed,
            target: policy.minForecastCoverage,
            status:
              observed < policy.minForecastCoverage
                ? "breached"
                : observed < Math.min(1, policy.minForecastCoverage * 1.1)
                  ? "at_risk"
                  : "met",
          },
    );
  }
  const status = objectives.some((objective) => objective.status === "breached")
    ? "breached"
    : objectives.some((objective) => objective.status === "at_risk")
      ? "at_risk"
      : objectives.length === 0 || objectives.some((objective) => objective.status === "unknown")
        ? "unknown"
        : "met";
  return { status, objectives };
}

type MutableRoute = Omit<
  LoopStrategyOutcome,
  "improvementRate" | "averageCostUsd" | "averageDurationMs" | "confidence"
> & {
  costUsd: number;
  durationMs: number;
};

/** Learns only from post-edit snapshots; the iteration-zero observation is not an executed strategy. */
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
    // The edit model is selected from the failure observed before the edit, not
    // from the post-edit verification category stored on this snapshot.
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
    };
    route.attempts += 1;
    route.costUsd += snapshot.costUsd ?? 0;
    route.durationMs += snapshot.durationMs ?? 0;
    if (snapshot.rolledBack || (previous && snapshot.failedTests > previous.failedTests)) route.regressions += 1;
    else if (previous && snapshot.failedTests < previous.failedTests) route.improvements += 1;
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
        averageCostUsd: route.attempts === 0 ? 0 : route.costUsd / route.attempts,
        averageDurationMs: route.attempts === 0 ? 0 : route.durationMs / route.attempts,
        confidence: confidenceForSamples(route.attempts),
      }),
    )
    .sort(
      (left, right) =>
        left.failureCategory.localeCompare(right.failureCategory) ||
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

function scenarioDefinition(
  definition: EngineeringGraphDefinition,
  concurrency: number,
  resource?: { id: string; capacity: number },
): EngineeringGraphDefinition {
  return {
    ...definition,
    maxConcurrency: concurrency,
    ...(resource
      ? { resourceCapacities: { ...(definition.resourceCapacities ?? {}), [resource.id]: resource.capacity } }
      : {}),
  };
}

function isParetoOptimal(
  candidate: Pick<EngineeringGraphOptimizationScenario, "changes" | "predictedMakespanMs">,
  scenarios: readonly Pick<EngineeringGraphOptimizationScenario, "changes" | "predictedMakespanMs">[],
): boolean {
  return !scenarios.some(
    (other) =>
      other !== candidate &&
      other.predictedMakespanMs <= candidate.predictedMakespanMs &&
      other.changes.length <= candidate.changes.length &&
      (other.predictedMakespanMs < candidate.predictedMakespanMs || other.changes.length < candidate.changes.length),
  );
}

function placementReport(
  state: EngineeringGraphState,
  executors: Readonly<Record<string, GraphExecutionAdapter>>,
): EngineeringGraphPlacement[] {
  return state.definition.nodes.flatMap((node): EngineeringGraphPlacement[] => {
    if (node.kind !== "remote" || !node.executor) return [];
    const adapter = executors[node.executor];
    if (!adapter)
      return [{ nodeId: node.id, executor: node.executor, status: "missing", reasons: ["Executor is not registered"] }];
    if (!adapter.trusted)
      return [{ nodeId: node.id, executor: node.executor, status: "untrusted", reasons: ["Executor is not trusted"] }];
    if ((node.executorProtocolVersion ?? 1) !== (adapter.protocolVersion ?? 1)) {
      return [
        {
          nodeId: node.id,
          executor: node.executor,
          status: "protocol_mismatch",
          reasons: ["Protocol version does not match"],
        },
      ];
    }
    if (node.requiresCancellation && !adapter.supportsCancellation) {
      return [
        {
          nodeId: node.id,
          executor: node.executor,
          status: "cancellation_unsupported",
          reasons: ["Cancellation is required"],
        },
      ];
    }
    return [{ nodeId: node.id, executor: node.executor, status: "eligible", reasons: [] }];
  });
}

/** Builds bounded counterfactuals and placement checks; it never mutates the Graph definition. */
export function buildEngineeringGraphOptimizationReport(
  state: EngineeringGraphState,
  health: EngineeringGraphHealthReport,
  executors: Readonly<Record<string, GraphExecutionAdapter>> = {},
): EngineeringGraphOptimizationReport {
  if (state.graphId !== health.graphId || state.fingerprint !== health.fingerprint) {
    throw new Error("Graph optimization health does not match the checkpoint generation");
  }
  const estimates = Object.fromEntries(
    health.nodes.flatMap((node) =>
      node.p50DurationMs === undefined ? [] : [[node.nodeId, { durationMs: node.p50DurationMs }]],
    ),
  );
  const baseline = simulateEngineeringGraph(state.definition, { estimates });
  const currentConcurrency = state.definition.maxConcurrency ?? 1;
  const concurrencyValues = [currentConcurrency];
  if (currentConcurrency > 1 || state.definition.managedWorktrees !== undefined) {
    for (
      let value = currentConcurrency + 1;
      value <= Math.min(MAX_GRAPH_CONCURRENCY, currentConcurrency + 3);
      value++
    ) {
      concurrencyValues.push(value);
    }
  }
  const configuredCapacities = state.definition.resourceCapacities ?? {};
  const resources = [
    ...new Set(baseline.nodes.filter((node) => node.resourceWaitMs > 0).flatMap((node) => node.resources)),
  ]
    .filter(
      (resource) =>
        (configuredCapacities[resource] ?? 1) < MAX_GRAPH_RESOURCE_CAPACITY &&
        (Object.hasOwn(configuredCapacities, resource) ||
          Object.keys(configuredCapacities).length < MAX_GRAPH_RESOURCE_CAPACITIES),
    )
    .sort()
    .slice(0, 4);
  const candidates: EngineeringGraphOptimizationScenario[] = [];
  for (const concurrency of concurrencyValues) {
    const resourceCandidates: Array<{ id: string; capacity: number } | undefined> = [undefined];
    for (const resource of resources) {
      resourceCandidates.push({ id: resource, capacity: (configuredCapacities[resource] ?? 1) + 1 });
    }
    for (const resource of resourceCandidates) {
      if (concurrency === currentConcurrency && resource === undefined) continue;
      const simulation = simulateEngineeringGraph(scenarioDefinition(state.definition, concurrency, resource), {
        estimates,
      });
      const changes: EngineeringGraphOptimizationScenario["changes"] = [];
      if (concurrency !== currentConcurrency) {
        changes.push({ kind: "max_concurrency", from: currentConcurrency, to: concurrency });
      }
      if (resource) {
        changes.push({
          kind: "resource_capacity",
          resource: resource.id,
          from: configuredCapacities[resource.id] ?? 1,
          to: resource.capacity,
        });
      }
      candidates.push({
        id: `scenario-${candidates.length + 1}`,
        changes,
        predictedMakespanMs: simulation.makespanMs,
        predictedActiveDurationMs: simulation.estimatedActiveDurationMs,
        predictedSavingsMs: Math.max(0, baseline.makespanMs - simulation.makespanMs),
        risks: simulation.risks,
        paretoOptimal: false,
      });
    }
  }
  for (const candidate of candidates) candidate.paretoOptimal = isParetoOptimal(candidate, candidates);
  candidates.sort(
    (left, right) =>
      Number(right.paretoOptimal) - Number(left.paretoOptimal) ||
      right.predictedSavingsMs - left.predictedSavingsMs ||
      left.changes.length - right.changes.length,
  );
  const evidenceCount = health.nodes.reduce((sum, node) => sum + node.samples, 0);
  const confidence = confidenceForSamples(evidenceCount);
  const placements = placementReport(state, executors);
  const proposalInputs = candidates
    .filter((scenario) => scenario.paretoOptimal && scenario.predictedSavingsMs > 0 && scenario.changes.length === 1)
    .slice(0, 4)
    .flatMap((scenario) => scenario.changes.map((change) => ({ scenario, change })));
  const proposals: OrchestrationProposalDraft[] = proposalInputs.map(({ scenario, change }) => {
    const action: OrchestrationProposalAction =
      change.kind === "max_concurrency"
        ? { kind: "graph_concurrency", value: change.to }
        : { kind: "graph_resource_capacity", resource: change.resource, value: change.to };
    return {
      id: proposalId("graph", state.graphId, state.fingerprint, action),
      scope: "graph",
      sourceId: state.graphId,
      sourceFingerprint: state.fingerprint,
      confidence,
      evidenceCount,
      risk: change.kind === "max_concurrency" ? "medium" : "low",
      title:
        change.kind === "max_concurrency"
          ? `Raise Graph concurrency to ${change.to}`
          : `Raise ${change.resource} capacity to ${change.to}`,
      rationale: `Pure simulation predicts ${scenario.predictedSavingsMs}ms lower makespan; approval records intent but does not apply it`,
      action,
    };
  });
  for (const placement of placements.filter((item) => item.status === "eligible")) {
    const action: OrchestrationProposalAction = {
      kind: "executor_placement",
      nodeId: placement.nodeId,
      executor: placement.executor,
    };
    proposals.push({
      id: proposalId("graph", state.graphId, state.fingerprint, action),
      scope: "graph",
      sourceId: state.graphId,
      sourceFingerprint: state.fingerprint,
      confidence: "high",
      evidenceCount: 1,
      risk: "medium",
      title: `Place ${placement.nodeId} on ${placement.executor}`,
      rationale: "The registered executor satisfies trust, protocol, and cancellation requirements",
      action,
    });
  }
  return {
    graphId: state.graphId,
    confidence,
    evidenceCount,
    scenarios: candidates.slice(0, 16),
    placements,
    proposals,
  };
}

export function buildLoopOptimizationProposals(
  state: LoopState,
  health: LoopHealthReport,
  strategy = analyzeLoopStrategyIntelligence(state),
): OrchestrationProposalDraft[] {
  if (state.loopId !== health.loopId) throw new Error("Loop optimization health does not match the checkpoint");
  const sourceFingerprint = createHash("sha256")
    .update(`${state.loopId}\0${state.controlRunId ?? "legacy"}\0${state.updatedAt}`)
    .digest("hex");
  const proposals: OrchestrationProposalDraft[] = strategy.recommendedRoutes.map((route) => {
    const action: OrchestrationProposalAction = {
      kind: "loop_route",
      failureCategory: route.failureCategory,
      model: route.model,
    };
    return {
      id: proposalId("loop", state.loopId, sourceFingerprint, action),
      scope: "loop",
      sourceId: state.loopId,
      sourceFingerprint,
      confidence: route.confidence,
      evidenceCount: route.evidenceCount,
      risk: "medium",
      title: `Prefer ${route.model} for ${route.failureCategory} failures`,
      rationale: "Retained post-edit snapshots show the strongest improvement rate for this failure category",
      action,
    };
  });
  if (health.status !== "healthy" && health.forecast.limitingBudget) {
    const action: OrchestrationProposalAction = {
      kind: "budget_review",
      budget: health.forecast.limitingBudget,
      forecastIterations: health.forecast.affordableIterations,
    };
    proposals.push({
      id: proposalId("loop", state.loopId, sourceFingerprint, action),
      scope: "loop",
      sourceId: state.loopId,
      sourceFingerprint,
      confidence: confidenceForSamples(health.forecast.samples),
      evidenceCount: health.forecast.samples,
      risk: "high",
      title: `Review the ${health.forecast.limitingBudget} budget`,
      rationale: `The conservative forecast leaves ${health.forecast.affordableIterations} affordable iteration(s); no budget is raised automatically`,
      action,
    });
  }
  return proposals;
}

/** Rolls child and top-level usage up without double-counting a child in its parent's totals. */
export function buildOrchestrationPortfolioReport(
  loops: readonly LoopState[],
  graphs: readonly EngineeringGraphState[],
  now = new Date(),
): OrchestrationPortfolioReport {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Orchestration portfolio time is invalid");
  const graphIds = new Set(graphs.map((graph) => graph.graphId));
  const rootLoops = loops.filter((loop) => !loop.parentGraph || !graphIds.has(loop.parentGraph.graphId));
  const rootGraphs = graphs.filter((graph) => !graph.parentGraph || !graphIds.has(graph.parentGraph.graphId));
  const items: OrchestrationPortfolioReport["items"] = [
    ...loops.map((loop) => ({
      kind: "loop" as const,
      id: loop.loopId,
      status: loop.status,
      costUsd: loop.costUsd,
      tokensUsed: loop.tokensUsed ?? 0,
      activeDurationMs: loop.elapsedMs ?? 0,
      ...(loop.parentGraph ? { parent: loop.parentGraph } : {}),
    })),
    ...graphs.map((graph) => ({
      kind: "graph" as const,
      id: graph.graphId,
      status: graph.status,
      costUsd: graph.spentCost,
      tokensUsed: graph.spentTokens,
      activeDurationMs: graph.elapsedMs,
      ...(graph.parentGraph ? { parent: graph.parentGraph } : {}),
    })),
  ].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
  const criticalStatuses = new Set(["failed", "budget", "verify_error", "agent_error", "no_progress", "exhausted"]);
  const warningStatuses = new Set(["paused", "interrupted", "requirements_pending", "cancelled"]);
  const status = items.some((item) => criticalStatuses.has(item.status))
    ? "critical"
    : items.some((item) => warningStatuses.has(item.status))
      ? "warning"
      : "healthy";
  return {
    generatedAt: now.toISOString(),
    status,
    totals: {
      loops: loops.length,
      graphs: graphs.length,
      costUsd:
        rootLoops.reduce((sum, loop) => sum + loop.costUsd, 0) +
        rootGraphs.reduce((sum, graph) => sum + graph.spentCost, 0),
      tokensUsed:
        rootLoops.reduce((sum, loop) => sum + (loop.tokensUsed ?? 0), 0) +
        rootGraphs.reduce((sum, graph) => sum + graph.spentTokens, 0),
      activeDurationMs:
        rootLoops.reduce((sum, loop) => sum + (loop.elapsedMs ?? 0), 0) +
        rootGraphs.reduce((sum, graph) => sum + graph.elapsedMs, 0),
      configuredCostBudgetUsd:
        rootLoops.reduce((sum, loop) => sum + (loop.costBudgetUsd ?? 0), 0) +
        rootGraphs.reduce((sum, graph) => sum + (graph.definition.costBudgetUsd ?? 0), 0),
      configuredTokenBudget:
        rootLoops.reduce((sum, loop) => sum + (loop.tokenBudget ?? 0), 0) +
        rootGraphs.reduce((sum, graph) => sum + (graph.definition.tokenBudget ?? 0), 0),
      configuredDurationBudgetMs:
        rootLoops.reduce((sum, loop) => sum + (loop.maxDurationMs ?? 0), 0) +
        rootGraphs.reduce((sum, graph) => sum + (graph.definition.maxDurationMs ?? 0), 0),
    },
    items,
  };
}

export function loopSloObservations(
  state: LoopState,
  health: LoopHealthReport,
): Parameters<typeof evaluateOrchestrationSlo>[0] {
  const failed = (state.snapshots ?? []).filter((snapshot: LoopIterationSnapshot) => snapshot.failedTests > 0).length;
  const samples = state.snapshots?.length ?? 0;
  const durations = (state.snapshots ?? [])
    .flatMap((snapshot: LoopIterationSnapshot) => (snapshot.durationMs === undefined ? [] : [snapshot.durationMs]))
    .sort((left, right) => left - right);
  const p95Index = durations.length === 0 ? -1 : Math.max(0, Math.ceil(durations.length * 0.95) - 1);
  const configuredStages = state.verificationPlan?.length ?? 1;
  return {
    p95DurationMs: p95Index < 0 ? undefined : durations[p95Index],
    costUsd: state.costUsd,
    failureRate: samples > 0 ? failed / samples : undefined,
    forecastCoverage: configuredStages === 0 ? undefined : health.verification.length / configuredStages,
  };
}
