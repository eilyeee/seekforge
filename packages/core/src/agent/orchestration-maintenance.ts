import type { GraphExecutionAdapter } from "./graph-engineering.js";
import { listWorkspaceEngineeringGraphTreeCheckpoints } from "./graph-migration.js";
import {
  buildWorkspaceOrchestrationControlAnalytics,
  recordEngineeringGraphForecastObservation,
  type WorkspaceOrchestrationControlAnalytics,
} from "./orchestration-control.js";
import { refreshWorkspaceOrchestrationIndex, type WorkspaceOrchestrationIndex } from "./orchestration-index.js";
import { buildWorkspaceOrchestrationReport } from "./orchestration-report.js";
import { recordOrchestrationProposals, type OrchestrationProposal } from "./orchestration-proposals.js";
import { reconcileOrchestrationRollouts, type OrchestrationRollout } from "./orchestration-rollouts.js";

export type WorkspaceOrchestrationMaintenanceResult = {
  proposals: OrchestrationProposal[];
  rollouts: OrchestrationRollout[];
  index: WorkspaceOrchestrationIndex;
  analytics: WorkspaceOrchestrationControlAnalytics;
};

/** Runs the safe background control loop; it never approves or starts a deployment. */
export function maintainWorkspaceOrchestration(
  workspace: string,
  options: {
    executors?: Readonly<Record<string, GraphExecutionAdapter>>;
    autoRollback?: boolean;
  } = {},
): WorkspaceOrchestrationMaintenanceResult {
  const executors = options.executors ?? {};
  const drafts = new Map<
    string,
    ReturnType<typeof buildWorkspaceOrchestrationReport>["loops"][number]["proposals"][number]
  >();
  let loopOffset = 0;
  let graphOffset = 0;
  for (let page = 0; page < 100; page++) {
    const report = buildWorkspaceOrchestrationReport(workspace, { executors, loopOffset, graphOffset, limit: 100 });
    for (const proposal of [
      ...report.loops.flatMap((loop) => loop.proposals),
      ...report.graphs.flatMap((graph) => graph.optimization.proposals),
    ]) {
      drafts.set(proposal.id, proposal);
    }
    const nextLoop = report.pagination.nextLoopOffset;
    const nextGraph = report.pagination.nextGraphOffset;
    if (nextLoop === undefined && nextGraph === undefined) break;
    loopOffset = nextLoop ?? report.pagination.totalLoops;
    graphOffset = nextGraph ?? report.pagination.totalGraphs;
  }
  const proposals = recordOrchestrationProposals(workspace, [...drafts.values()]);
  const graphStates = new Map(
    listWorkspaceEngineeringGraphTreeCheckpoints(workspace).map((checkpoint) => [
      `${checkpoint.state.graphId}\0${checkpoint.state.fingerprint}`,
      checkpoint.state,
    ]),
  );
  const firstPage = buildWorkspaceOrchestrationReport(workspace, { executors, limit: 100 });
  let nextGraphOffset = firstPage.pagination.nextGraphOffset;
  let graphReports = firstPage.graphs;
  for (;;) {
    for (const graph of graphReports) {
      const state = graphStates.get(`${graph.graphId}\0${graph.health.fingerprint}`);
      if (state) recordEngineeringGraphForecastObservation(workspace, state, graph.optimization.uncertainty);
    }
    if (nextGraphOffset === undefined) break;
    const page = buildWorkspaceOrchestrationReport(workspace, {
      executors,
      loopOffset: firstPage.pagination.totalLoops,
      graphOffset: nextGraphOffset,
      limit: 100,
    });
    graphReports = page.graphs;
    nextGraphOffset = page.pagination.nextGraphOffset;
  }
  const rollouts = reconcileOrchestrationRollouts(workspace, { autoRollback: options.autoRollback === true });
  const index = refreshWorkspaceOrchestrationIndex(workspace);
  const analytics = buildWorkspaceOrchestrationControlAnalytics(workspace, {
    maxBreachRate: firstPage.policyState?.maxBreachRate,
  });
  return { proposals, rollouts, index, analytics };
}
