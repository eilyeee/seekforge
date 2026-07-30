import {
  analyzeGraphSchedulingIntelligence,
  summarizeGraphSchedulingIntelligence,
  type GraphSchedulingObservation,
} from "./graph-scheduling-history.js";
import { simulateEngineeringGraph } from "./graph-simulation.js";
import type { EngineeringGraphState } from "./graph-state.js";
import {
  graphNodeIsEffectful,
  MAX_GRAPH_CONCURRENCY,
  MAX_GRAPH_RESOURCE_CAPACITIES,
  MAX_GRAPH_RESOURCE_CAPACITY,
} from "./graph-contract.js";
import { orchestrationResourcesOverlap } from "./orchestration-scheduler.js";

export type EngineeringGraphHealthNode = {
  nodeId: string;
  status: "pending" | EngineeringGraphState["results"][number]["status"];
  samples: number;
  confidence: "none" | "low" | "medium" | "high";
  p50DurationMs?: number;
  p95DurationMs?: number;
  actualDurationMs?: number;
  forecastDriftMs?: number;
  failureRate?: number;
  averageResourceWaitMs?: number;
  sessionId?: string;
};

export type EngineeringGraphHealthReport = {
  graphId: string;
  fingerprint: string;
  generatedAt: string;
  status: "unknown" | "healthy" | "warning" | "critical";
  predictedMakespanMs: number;
  predictedP95MakespanMs: number;
  forecastCoverage: { measuredNodes: number; totalNodes: number; ratio: number };
  criticalPath: string[];
  bottlenecks: string[];
  risks: string[];
  recommendations: Array<{
    kind: "max_concurrency" | "resource_capacity";
    target: string;
    currentValue: number;
    suggestedValue: number;
    predictedSavingsMs: number;
  }>;
  nodes: EngineeringGraphHealthNode[];
  findings: ReturnType<typeof analyzeGraphSchedulingIntelligence>;
  lineage: Array<{ nodeId: string; sessionId: string }>;
};

/** Joins Graph, child-session, and verifier scheduling evidence without node output. */
export function buildEngineeringGraphHealthReport(
  state: EngineeringGraphState,
  observations: readonly GraphSchedulingObservation[],
  now = new Date(),
): EngineeringGraphHealthReport {
  const current = observations.filter(
    (item) => item.graphId === state.graphId && item.fingerprint === state.fingerprint,
  );
  const intelligence = summarizeGraphSchedulingIntelligence(current);
  const byNode = new Map(intelligence.map((entry) => [entry.nodeId, entry]));
  const estimates = Object.fromEntries(
    intelligence
      .filter((entry) => entry.p50DurationMs > 0)
      .map((entry) => [entry.nodeId, { durationMs: entry.p50DurationMs }]),
  );
  const p95Estimates = Object.fromEntries(
    intelligence
      .filter((entry) => entry.p95DurationMs > 0)
      .map((entry) => [entry.nodeId, { durationMs: entry.p95DurationMs }]),
  );
  const simulation = simulateEngineeringGraph(state.definition, { estimates });
  const p95Simulation = simulateEngineeringGraph(state.definition, { estimates: p95Estimates });
  const findings = analyzeGraphSchedulingIntelligence(intelligence);
  const forecastable = state.definition.nodes.filter(graphNodeIsEffectful);
  const measuredNodes = forecastable.filter((node) => byNode.has(node.id)).length;
  const forecastCoverage = {
    measuredNodes,
    totalNodes: forecastable.length,
    ratio: forecastable.length === 0 ? 1 : measuredNodes / forecastable.length,
  };
  const recommendations: EngineeringGraphHealthReport["recommendations"] = [];
  const currentConcurrency = state.definition.maxConcurrency ?? 1;
  const concurrencyIncreaseIsValid = currentConcurrency > 1 || state.definition.managedWorktrees !== undefined;
  if (currentConcurrency < MAX_GRAPH_CONCURRENCY && concurrencyIncreaseIsValid) {
    const candidate = simulateEngineeringGraph(
      { ...state.definition, maxConcurrency: currentConcurrency + 1 },
      { estimates },
    );
    if (candidate.makespanMs < simulation.makespanMs) {
      recommendations.push({
        kind: "max_concurrency",
        target: "maxConcurrency",
        currentValue: currentConcurrency,
        suggestedValue: currentConcurrency + 1,
        predictedSavingsMs: simulation.makespanMs - candidate.makespanMs,
      });
    }
  }
  const configuredCapacities = state.definition.resourceCapacities ?? {};
  const configuredResources = Object.keys(configuredCapacities);
  const capacityCandidates = new Set([
    ...configuredResources,
    ...simulation.nodes.filter((node) => node.resourceWaitMs > 0).flatMap((node) => node.resources),
  ]);
  const relevantCapacities = [...capacityCandidates]
    .map((resource) => [resource, configuredCapacities[resource] ?? 1] as const)
    .filter(
      ([resource, capacity]) =>
        capacity < MAX_GRAPH_RESOURCE_CAPACITY &&
        (Object.hasOwn(configuredCapacities, resource) || configuredResources.length < MAX_GRAPH_RESOURCE_CAPACITIES) &&
        simulation.nodes.some(
          (node) =>
            node.resourceWaitMs > 0 &&
            node.resources.some((requested) => orchestrationResourcesOverlap(resource, requested)),
        ),
    )
    .slice(0, 8);
  for (const [resource, capacity] of relevantCapacities) {
    const candidate = simulateEngineeringGraph(
      {
        ...state.definition,
        resourceCapacities: { ...configuredCapacities, [resource]: capacity + 1 },
      },
      { estimates },
    );
    if (candidate.makespanMs < simulation.makespanMs) {
      recommendations.push({
        kind: "resource_capacity",
        target: resource,
        currentValue: capacity,
        suggestedValue: capacity + 1,
        predictedSavingsMs: simulation.makespanMs - candidate.makespanMs,
      });
    }
  }
  recommendations.sort((left, right) => right.predictedSavingsMs - left.predictedSavingsMs);
  const status =
    intelligence.length === 0
      ? "unknown"
      : findings.some((finding) => finding.severity === "critical")
        ? "critical"
        : findings.length > 0 || p95Simulation.risks.length > 0 || forecastCoverage.ratio < 1
          ? "warning"
          : "healthy";
  const duration = (result: EngineeringGraphState["results"][number] | undefined): number | undefined => {
    if (!result?.startedAt || !result.completedAt) return undefined;
    const value = Date.parse(result.completedAt) - Date.parse(result.startedAt);
    return Number.isFinite(value) ? Math.max(0, value) : undefined;
  };
  const nodes = state.definition.nodes.map((node): EngineeringGraphHealthNode => {
    const result = state.results.find((candidate) => candidate.id === node.id);
    const entry = byNode.get(node.id);
    const actualDurationMs = duration(result);
    const priorForecastMs = current.find(
      (observation) =>
        observation.nodeId === node.id &&
        observation.recordedAt === result?.completedAt &&
        observation.predictedDurationMs !== undefined,
    )?.predictedDurationMs;
    return {
      nodeId: node.id,
      status: result?.status ?? "pending",
      samples: entry?.samples ?? 0,
      confidence: entry?.confidence ?? "none",
      ...(entry
        ? {
            p50DurationMs: entry.p50DurationMs,
            p95DurationMs: entry.p95DurationMs,
            failureRate: entry.decayedFailureRate,
            averageResourceWaitMs: entry.averageResourceWaitMs,
          }
        : {}),
      ...(actualDurationMs !== undefined ? { actualDurationMs } : {}),
      ...(actualDurationMs !== undefined && priorForecastMs !== undefined
        ? { forecastDriftMs: actualDurationMs - priorForecastMs }
        : {}),
      ...(result?.sessionId ? { sessionId: result.sessionId } : {}),
    };
  });
  return {
    graphId: state.graphId,
    fingerprint: state.fingerprint,
    generatedAt: now.toISOString(),
    status,
    predictedMakespanMs: simulation.makespanMs,
    predictedP95MakespanMs: p95Simulation.makespanMs,
    forecastCoverage,
    criticalPath: simulation.criticalPath,
    bottlenecks: simulation.bottlenecks,
    risks: p95Simulation.risks,
    recommendations,
    nodes,
    findings,
    lineage: nodes.flatMap((node) => (node.sessionId ? [{ nodeId: node.nodeId, sessionId: node.sessionId }] : [])),
  };
}
