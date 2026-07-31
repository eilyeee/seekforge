import {
  applyOrchestrationProposal,
  buildWorkspaceOrchestrationReport,
  graphExecutorsWithPlugins,
  listOrchestrationProposals,
  listOrchestrationDeployments,
  loadPluginContributions,
  observeOrchestrationDeployments,
  recordOrchestrationProposals,
  readWorkspaceOrchestrationSloPolicy,
  readWorkspaceOrchestrationIndex,
  rollbackOrchestrationDeployment,
  refreshWorkspaceOrchestrationIndex,
  setOrchestrationProposalStatus,
  setWorkspaceOrchestrationSloPolicy,
  type OrchestrationSloPolicy,
  advanceOrchestrationRollout,
  listOrchestrationRollouts,
  maintainWorkspaceOrchestration,
  reconcileOrchestrationRollouts,
  startOrchestrationRollout,
} from "@seekforge/core";
import { fail } from "../colors.js";

function executors(workspace: string) {
  return graphExecutorsWithPlugins(loadPluginContributions(workspace), {});
}

function report(
  workspace: string,
  policy: OrchestrationSloPolicy,
  pagination: { loopOffset?: number; graphOffset?: number; limit?: number } = {},
) {
  return buildWorkspaceOrchestrationReport(workspace, {
    policy,
    executors: executors(workspace),
    ...pagination,
  });
}

export function orchestrationReportCommand(
  policy: OrchestrationSloPolicy,
  pagination: { loopOffset?: number; graphOffset?: number; limit?: number } = {},
): void {
  try {
    console.log(JSON.stringify(report(process.cwd(), policy, pagination), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationProposalsCommand(
  operation: "list" | "refresh" | "approve" | "dismiss" | "apply" | "rollback" | "observe",
  id?: string,
  expectedUpdatedAt?: string,
  autoRollback = false,
): void {
  try {
    const workspace = process.cwd();
    if (operation === "list") {
      console.log(
        JSON.stringify(
          { proposals: listOrchestrationProposals(workspace), deployments: listOrchestrationDeployments(workspace) },
          null,
          2,
        ),
      );
      return;
    }
    if (operation === "refresh") {
      const current = report(workspace, {});
      const drafts = [
        ...current.loops.flatMap((loop) => loop.proposals),
        ...current.graphs.flatMap((graph) => graph.optimization.proposals),
      ];
      console.log(
        JSON.stringify(
          {
            proposals: recordOrchestrationProposals(workspace, drafts),
            index: refreshWorkspaceOrchestrationIndex(workspace),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (operation === "observe") {
      console.log(
        JSON.stringify(
          {
            deployments: observeOrchestrationDeployments(workspace, { autoRollback }),
          },
          null,
          2,
        ),
      );
      return;
    }
    if (!id) throw new Error(`orchestration proposals ${operation} requires a proposal id`);
    if (operation === "apply") {
      console.log(
        JSON.stringify(
          applyOrchestrationProposal(workspace, id, { expectedUpdatedAt, executors: executors(workspace) }),
          null,
          2,
        ),
      );
      return;
    }
    if (operation === "rollback") {
      console.log(JSON.stringify(rollbackOrchestrationDeployment(workspace, id), null, 2));
      return;
    }
    console.log(
      JSON.stringify(
        setOrchestrationProposalStatus(
          workspace,
          id,
          operation === "approve" ? "approved" : "dismissed",
          expectedUpdatedAt,
        ),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationPolicyCommand(
  operation: "show" | "set",
  policy: OrchestrationSloPolicy,
  options: { evaluationWindow?: number; maxBreachRate?: number; expectedUpdatedAt?: string } = {},
): void {
  try {
    const workspace = process.cwd();
    const result =
      operation === "show"
        ? readWorkspaceOrchestrationSloPolicy(workspace)
        : setWorkspaceOrchestrationSloPolicy(workspace, policy, options);
    console.log(JSON.stringify(result ?? null, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationIndexCommand(operation: "show" | "refresh"): void {
  try {
    const workspace = process.cwd();
    console.log(
      JSON.stringify(
        operation === "show"
          ? (readWorkspaceOrchestrationIndex(workspace) ?? null)
          : refreshWorkspaceOrchestrationIndex(workspace),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationRolloutCommand(
  operation: "list" | "start" | "advance" | "reconcile",
  id?: string,
  options: { expectedUpdatedAt?: string; minSamples?: number; autoRollback?: boolean } = {},
): void {
  try {
    const workspace = process.cwd();
    if ((operation === "start" || operation === "advance") && !id) {
      throw new Error(`orchestration rollout ${operation} requires a proposal id`);
    }
    const result =
      operation === "list"
        ? listOrchestrationRollouts(workspace)
        : operation === "reconcile"
          ? reconcileOrchestrationRollouts(workspace, { autoRollback: options.autoRollback === true })
          : operation === "start"
            ? startOrchestrationRollout(workspace, id!, {
                expectedUpdatedAt: options.expectedUpdatedAt,
                minSamples: options.minSamples,
              })
            : advanceOrchestrationRollout(workspace, id!, { executors: executors(workspace) });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationMaintenanceCommand(autoRollback = false): void {
  try {
    const workspace = process.cwd();
    console.log(
      JSON.stringify(
        maintainWorkspaceOrchestration(workspace, { executors: executors(workspace), autoRollback }),
        null,
        2,
      ),
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
