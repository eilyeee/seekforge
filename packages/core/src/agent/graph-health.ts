import {
  analyzeGraphSchedulingIntelligence,
  summarizeGraphSchedulingIntelligence,
  type GraphSchedulingObservation,
} from "./graph-scheduling-history.js";
import { simulateEngineeringGraph } from "./graph-simulation.js";
import type { EngineeringGraphState } from "./graph-state.js";

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
  criticalPath: string[];
  bottlenecks: string[];
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
  const simulation = simulateEngineeringGraph(state.definition, { estimates });
  const findings = analyzeGraphSchedulingIntelligence(intelligence);
  const status =
    intelligence.length === 0
      ? "unknown"
      : findings.some((finding) => finding.severity === "critical")
        ? "critical"
        : findings.length > 0
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
    criticalPath: simulation.criticalPath,
    bottlenecks: simulation.bottlenecks,
    nodes,
    findings,
    lineage: nodes.flatMap((node) => (node.sessionId ? [{ nodeId: node.nodeId, sessionId: node.sessionId }] : [])),
  };
}
