import {
  inspectEngineeringGraphArtifactStore,
  listEngineeringGraphArtifactAttestations,
} from "./graph-artifact-store.js";
import { listWorkspaceGraphExecutorReservations } from "./graph-capacity.js";
import { readEngineeringGraphHistory } from "./graph-history.js";
import { listEngineeringGraphStates } from "./graph-state.js";
import { readLoopHistory } from "./loop-history.js";
import { listLoopStates } from "./loop-state.js";
import {
  diagnoseEngineeringGraphCheckpoint,
  diagnoseLoopCheckpoint,
  type OrchestrationDiagnosticReport,
} from "./orchestration-diagnostics.js";
import {
  listOrchestrationDecisions,
  readOrchestrationControllerState,
  type OrchestrationControllerState,
  type OrchestrationDecision,
} from "./orchestration-decisions.js";
import { listOrchestrationRollouts, type OrchestrationRollout } from "./orchestration-rollouts.js";

export type WorkspaceOperationalDiagnostics = {
  generatedAt: string;
  healthy: boolean;
  controller: OrchestrationControllerState;
  decisions: OrchestrationDecision[];
  rollouts: OrchestrationRollout[];
  loops: OrchestrationDiagnosticReport[];
  graphs: OrchestrationDiagnosticReport[];
  reservations: ReturnType<typeof listWorkspaceGraphExecutorReservations>;
  artifactStore: {
    blobs: number;
    bytes: number;
    referenced: number;
    attestations: number;
  };
};

/** Builds one bounded, read-only support snapshot for the workspace control plane. */
export function buildWorkspaceOperationalDiagnostics(workspace: string): WorkspaceOperationalDiagnostics {
  const loops = listLoopStates(workspace).map((state) =>
    diagnoseLoopCheckpoint(state, readLoopHistory(workspace, state.loopId, { limit: 2_000, tail: true })),
  );
  const graphs = listEngineeringGraphStates(workspace).map((state) =>
    diagnoseEngineeringGraphCheckpoint(
      state,
      readEngineeringGraphHistory(workspace, state.graphId, { limit: 2_000, tail: true }),
    ),
  );
  const artifacts = inspectEngineeringGraphArtifactStore(workspace);
  return {
    generatedAt: new Date().toISOString(),
    healthy: [...loops, ...graphs].every((report) => report.healthy),
    controller: readOrchestrationControllerState(workspace),
    decisions: listOrchestrationDecisions(workspace).slice(0, 100),
    rollouts: listOrchestrationRollouts(workspace),
    loops,
    graphs,
    reservations: listWorkspaceGraphExecutorReservations(workspace),
    artifactStore: {
      blobs: artifacts.length,
      bytes: artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0),
      referenced: artifacts.filter((artifact) => artifact.referenced).length,
      attestations: listEngineeringGraphArtifactAttestations(workspace).length,
    },
  };
}
