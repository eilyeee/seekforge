import { realpathSync } from "node:fs";
import type { GraphExecutionAdapter } from "./graph-engineering.js";
import { buildEngineeringGraphHealthReport } from "./graph-health.js";
import { readEngineeringGraphHistory } from "./graph-history.js";
import { listWorkspaceEngineeringGraphTreeCheckpoints } from "./graph-migration.js";
import { readEngineeringGraphRunSnapshots } from "./graph-run-history.js";
import { planEngineeringGraphArtifactReuse } from "./graph-artifact-catalog.js";
import { buildLoopHealthReport } from "./loop-health.js";
import { readLoopHistory } from "./loop-history.js";
import { listLoopStates } from "./loop-state.js";
import { readLoopVerificationIntelligence } from "./loop-verification-intelligence.js";
import { readGraphSchedulingObservations } from "./graph-scheduling-history.js";
import { replayEngineeringGraphHistory, replayLoopHistory } from "./orchestration-diagnostics.js";
import {
  analyzeLoopStrategyIntelligence,
  buildEngineeringGraphOptimizationReport,
  buildLoopOptimizationProposals,
  buildOrchestrationPortfolioReport,
  evaluateOrchestrationSlo,
  loopSloObservations,
  type OrchestrationSloPolicy,
} from "./orchestration-intelligence.js";
import { listOrchestrationProposals } from "./orchestration-proposals.js";
import { listOrchestrationDeployments } from "./orchestration-deployments.js";
import { readWorkspaceOrchestrationSloPolicy } from "./orchestration-policy.js";
import { buildWorkspaceOrchestrationControlAnalytics } from "./orchestration-control.js";
import { buildWorkspaceContextualLoopRoutingProfile } from "./orchestration-routing.js";
import { buildEngineeringGraphRuntimeReplan, buildWorkspaceExecutorCapacityReport } from "./graph-runtime-plan.js";
import { listOrchestrationRollouts } from "./orchestration-rollouts.js";
import { listEngineeringGraphArtifactAttestations } from "./graph-artifact-store.js";

export type WorkspaceOrchestrationReportOptions = {
  policy?: OrchestrationSloPolicy;
  executors?: Readonly<Record<string, GraphExecutionAdapter>>;
  loopOffset?: number;
  graphOffset?: number;
  limit?: number;
};

const MAX_REPORT_LOOPS = 100;
const MAX_REPORT_GRAPHS = 100;

/** Joins persisted Loop and Graph evidence into one bounded workspace report. */
export function buildWorkspaceOrchestrationReport(
  workspace: string,
  options: WorkspaceOrchestrationReportOptions = {},
) {
  const limit = options.limit ?? MAX_REPORT_LOOPS;
  const loopOffset = options.loopOffset ?? 0;
  const graphOffset = options.graphOffset ?? 0;
  for (const [name, value] of [
    ["limit", limit],
    ["loopOffset", loopOffset],
    ["graphOffset", graphOffset],
  ] as const) {
    const maximum = name === "limit" ? 100 : 10_000;
    if (!Number.isSafeInteger(value) || value < (name === "limit" ? 1 : 0) || value > maximum) {
      throw new RangeError(`Orchestration report ${name} is out of range`);
    }
  }
  const allLoops = listLoopStates(workspace);
  const allGraphCheckpoints = listWorkspaceEngineeringGraphTreeCheckpoints(workspace);
  const allGraphs = allGraphCheckpoints.map((checkpoint) => checkpoint.state);
  const physicalWorkspace = realpathSync.native(workspace);
  const workspaceGraphs = allGraphCheckpoints
    .filter((checkpoint) => checkpoint.workspace === physicalWorkspace)
    .map((checkpoint) => checkpoint.state);
  const loops = allLoops.slice(loopOffset, loopOffset + Math.min(limit, MAX_REPORT_LOOPS));
  const graphCheckpoints = allGraphCheckpoints.slice(graphOffset, graphOffset + Math.min(limit, MAX_REPORT_GRAPHS));
  const graphs = graphCheckpoints.map((checkpoint) => checkpoint.state);
  const verification = readLoopVerificationIntelligence(workspace);
  const persistedPolicy = readWorkspaceOrchestrationSloPolicy(workspace);
  const policy = { ...(persistedPolicy?.policy ?? {}), ...(options.policy ?? {}) };
  const contextualRouting = buildWorkspaceContextualLoopRoutingProfile(workspace);
  const attestationCounts = new Map<string, number>();
  for (const attestationWorkspace of new Set(allGraphCheckpoints.map((checkpoint) => checkpoint.workspace))) {
    for (const attestation of listEngineeringGraphArtifactAttestations(attestationWorkspace)) {
      const key = `${attestationWorkspace}\0${attestation.sha256}`;
      attestationCounts.set(key, (attestationCounts.get(key) ?? 0) + 1);
    }
  }
  const completePortfolio = buildOrchestrationPortfolioReport(allLoops, allGraphs);
  const visiblePortfolio = buildOrchestrationPortfolioReport(loops, graphs);
  const loopReports = loops.map((state) => {
    const health = buildLoopHealthReport(state, verification);
    const strategy = analyzeLoopStrategyIntelligence(state);
    const history = readLoopHistory(workspace, state.loopId, { limit: 2_000, tail: true });
    return {
      loopId: state.loopId,
      health,
      strategy,
      slo: evaluateOrchestrationSlo(loopSloObservations(state, health), policy),
      replay: replayLoopHistory(state.loopId, history),
      proposals: buildLoopOptimizationProposals(state, health, strategy),
    };
  });
  const graphReports = graphCheckpoints.map(({ state, workspace: stateWorkspace }) => {
    const scheduling = readGraphSchedulingObservations(stateWorkspace);
    const health = buildEngineeringGraphHealthReport(state, scheduling);
    const optimization = buildEngineeringGraphOptimizationReport(state, health, options.executors ?? {});
    const durableHistory = readEngineeringGraphHistory(stateWorkspace, state.graphId, {
      limit: 2_000,
      tail: true,
    });
    const replayHistory =
      durableHistory.length > 0 ? durableHistory : state.events.map((event) => ({ seq: event.sequence, event }));
    const failureSamples = health.nodes.filter((node) => node.failureRate !== undefined);
    const totalFailureSamples = failureSamples.reduce((sum, node) => sum + node.samples, 0);
    const failureRate =
      totalFailureSamples === 0
        ? undefined
        : failureSamples.reduce((sum, node) => sum + node.failureRate! * node.samples, 0) / totalFailureSamples;
    return {
      graphId: state.graphId,
      health,
      optimization,
      slo: evaluateOrchestrationSlo(
        {
          p95DurationMs: health.forecastCoverage.measuredNodes > 0 ? health.predictedP95MakespanMs : undefined,
          costUsd: state.spentCost,
          failureRate,
          forecastCoverage: health.forecastCoverage.ratio,
        },
        policy,
      ),
      replay: replayEngineeringGraphHistory(state.graphId, replayHistory),
      runtimeReplan: buildEngineeringGraphRuntimeReplan(stateWorkspace, state, options.executors ?? {}),
      artifactReuse: planEngineeringGraphArtifactReuse(
        state,
        readEngineeringGraphRunSnapshots(stateWorkspace, state.graphId),
        stateWorkspace,
      ).map((artifact) => ({
        ...artifact,
        attestationCount: attestationCounts.get(`${stateWorkspace}\0${artifact.sha256}`) ?? 0,
      })),
    };
  });
  const evaluationWindow = persistedPolicy?.evaluationWindow ?? 100;
  const maxBreachRate = persistedPolicy?.maxBreachRate ?? 0.05;
  const evaluations = [...loopReports, ...graphReports]
    .flatMap((item) => item.slo.objectives)
    .filter((objective) => objective.status !== "unknown")
    .slice(0, evaluationWindow);
  const breached = evaluations.filter((objective) => objective.status === "breached").length;
  const breachRate = evaluations.length === 0 ? 0 : breached / evaluations.length;
  return {
    portfolio: { ...completePortfolio, items: visiblePortfolio.items },
    policy,
    policyState: persistedPolicy,
    controlAnalytics: buildWorkspaceOrchestrationControlAnalytics(workspace, {
      maxBreachRate: persistedPolicy?.maxBreachRate,
    }),
    contextualRouting,
    executorCapacity: buildWorkspaceExecutorCapacityReport(workspace, workspaceGraphs, options.executors ?? {}),
    sloSummary: {
      scope: "page" as const,
      evaluations: evaluations.length,
      breached,
      breachRate,
      maxBreachRate,
      status:
        evaluations.length === 0
          ? "unknown"
          : breachRate > maxBreachRate
            ? "breached"
            : breachRate > maxBreachRate * 0.8
              ? "at_risk"
              : "met",
      errorBudgetRemaining: Math.max(0, maxBreachRate * evaluations.length - breached),
    },
    pagination: {
      loopOffset,
      graphOffset,
      limit,
      totalLoops: allLoops.length,
      totalGraphs: allGraphs.length,
      nextLoopOffset: loopOffset + loops.length < allLoops.length ? loopOffset + loops.length : undefined,
      nextGraphOffset: graphOffset + graphs.length < allGraphs.length ? graphOffset + graphs.length : undefined,
    },
    loops: loopReports,
    graphs: graphReports,
    reviewedProposals: listOrchestrationProposals(workspace),
    deployments: listOrchestrationDeployments(workspace),
    rollouts: listOrchestrationRollouts(workspace),
  };
}

export type WorkspaceOrchestrationReport = ReturnType<typeof buildWorkspaceOrchestrationReport>;
