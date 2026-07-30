import {
  buildWorkspaceOrchestrationReport,
  graphExecutorsWithPlugins,
  listOrchestrationProposals,
  loadPluginContributions,
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
  type OrchestrationSloPolicy,
} from "@seekforge/core";
import { fail } from "../colors.js";

function report(workspace: string, policy: OrchestrationSloPolicy) {
  return buildWorkspaceOrchestrationReport(workspace, {
    policy,
    executors: graphExecutorsWithPlugins(loadPluginContributions(workspace), {}),
  });
}

export function orchestrationReportCommand(policy: OrchestrationSloPolicy): void {
  try {
    console.log(JSON.stringify(report(process.cwd(), policy), null, 2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function orchestrationProposalsCommand(
  operation: "list" | "refresh" | "approve" | "dismiss",
  id?: string,
  expectedUpdatedAt?: string,
): void {
  try {
    const workspace = process.cwd();
    if (operation === "list") {
      console.log(JSON.stringify({ proposals: listOrchestrationProposals(workspace) }, null, 2));
      return;
    }
    if (operation === "refresh") {
      const current = report(workspace, {});
      const drafts = [
        ...current.loops.flatMap((loop) => loop.proposals),
        ...current.graphs.flatMap((graph) => graph.optimization.proposals),
      ];
      console.log(JSON.stringify({ proposals: recordOrchestrationProposals(workspace, drafts) }, null, 2));
      return;
    }
    if (!id) throw new Error(`orchestration proposals ${operation} requires a proposal id`);
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
