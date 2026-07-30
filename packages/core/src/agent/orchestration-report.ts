import type { GraphExecutionAdapter } from "./graph-engineering.js";
import { buildEngineeringGraphHealthReport } from "./graph-health.js";
import { readEngineeringGraphHistory } from "./graph-history.js";
import { readEngineeringGraphRunSnapshots } from "./graph-run-history.js";
import { listEngineeringGraphStates } from "./graph-state.js";
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

export type WorkspaceOrchestrationReportOptions = {
  policy?: OrchestrationSloPolicy;
  executors?: Readonly<Record<string, GraphExecutionAdapter>>;
};

const MAX_REPORT_LOOPS = 100;
const MAX_REPORT_GRAPHS = 100;

/** Joins persisted Loop and Graph evidence into one bounded workspace report. */
export function buildWorkspaceOrchestrationReport(
  workspace: string,
  options: WorkspaceOrchestrationReportOptions = {},
) {
  const allLoops = listLoopStates(workspace);
  const allGraphs = listEngineeringGraphStates(workspace);
  const loops = allLoops.slice(0, MAX_REPORT_LOOPS);
  const graphs = allGraphs.slice(0, MAX_REPORT_GRAPHS);
  const verification = readLoopVerificationIntelligence(workspace);
  const scheduling = readGraphSchedulingObservations(workspace);
  const policy = options.policy ?? {};
  const completePortfolio = buildOrchestrationPortfolioReport(allLoops, allGraphs);
  const visiblePortfolio = buildOrchestrationPortfolioReport(loops, graphs);
  return {
    portfolio: { ...completePortfolio, items: visiblePortfolio.items },
    policy,
    loops: loops.map((state) => {
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
    }),
    graphs: graphs.map((state) => {
      const health = buildEngineeringGraphHealthReport(state, scheduling);
      const optimization = buildEngineeringGraphOptimizationReport(state, health, options.executors ?? {});
      const durableHistory = readEngineeringGraphHistory(workspace, state.graphId, { limit: 2_000, tail: true });
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
        artifactReuse: planEngineeringGraphArtifactReuse(
          state,
          readEngineeringGraphRunSnapshots(workspace, state.graphId),
        ),
      };
    }),
    reviewedProposals: listOrchestrationProposals(workspace),
  };
}

export type WorkspaceOrchestrationReport = ReturnType<typeof buildWorkspaceOrchestrationReport>;
