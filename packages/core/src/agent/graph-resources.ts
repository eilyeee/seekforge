import { isWorktreeDirty, listGitWorktrees, removeWorktree } from "../worktree.js";
import { loadEngineeringGraphState } from "./graph-state.js";
import { ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID } from "./graph-contract.js";
import { managedOrchestrationWorktreeSlug } from "./orchestration-worktrees.js";
import {
  acquireManagedOrchestrationWorktreeLease,
  promoteManagedOrchestrationWorktree,
  resolveManagedOrchestrationWorktree,
} from "./loop-managed-worktree.js";
import {
  archiveOrchestrationResources,
  measureManagedWorktreeDirectory,
  orchestrationResourcesArchived,
} from "./orchestration-resources.js";
import { acquireSessionLease, isSessionRunActive } from "./session-lease.js";

export type EngineeringGraphResourceReport = {
  graphId: string;
  completed: boolean;
  archived: boolean;
  active: boolean;
  totalBytes: number;
  truncated: boolean;
  worktrees: Array<{ branch: string; path: string; bytes: number }>;
};

export type EngineeringGraphResourcePruneResult = {
  graphId: string;
  dryRun: boolean;
  removed: string[];
  retained: string[];
};

function branchesFor(
  workspace: string,
  graphId: string,
): { completed: boolean; generation: string; branches: string[] } {
  const state = loadEngineeringGraphState(workspace, graphId);
  if (!state) throw new Error(`Persisted Graph not found: ${graphId}`);
  const branches = new Set(state.results.flatMap((result) => (result.managedBranch ? [result.managedBranch] : [])));
  if (state.definition.managedWorktrees) {
    for (const node of state.definition.nodes) {
      if (node.kind !== "gate" && node.kind !== "router") {
        branches.add(`seekforge/${managedOrchestrationWorktreeSlug("graph", graphId, node.id)}`);
      }
    }
    if (state.definition.fanIn) {
      branches.add(
        `seekforge/${managedOrchestrationWorktreeSlug("graph", graphId, ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID)}`,
      );
    }
  }
  if (state.fanIn?.branch) branches.add(state.fanIn.branch);
  return {
    completed: state.completedAt !== undefined,
    generation: state.resourceGeneration ?? state.createdAt,
    branches: [...branches],
  };
}

export async function inspectEngineeringGraphResources(
  workspace: string,
  graphId: string,
): Promise<EngineeringGraphResourceReport> {
  const { completed, generation, branches } = branchesFor(workspace, graphId);
  const report: EngineeringGraphResourceReport = {
    graphId,
    completed,
    archived: orchestrationResourcesArchived(workspace, "graph", graphId, generation),
    active: isSessionRunActive(workspace, `engineering-graph-${graphId}`),
    totalBytes: 0,
    truncated: false,
    worktrees: [],
  };
  if (branches.length === 0) return report;
  const entries = await listGitWorktrees(workspace);
  for (const branch of branches) {
    const entry = entries.find((item) => item.branch === branch);
    if (!entry) continue;
    const { root, physical } = resolveManagedOrchestrationWorktree(workspace, entry.path, branch);
    const measured = measureManagedWorktreeDirectory(physical, root);
    report.totalBytes += measured.bytes;
    report.truncated ||= measured.truncated;
    report.worktrees.push({ branch, path: physical, bytes: measured.bytes });
  }
  return report;
}

export function archiveEngineeringGraphResources(
  workspace: string,
  graphId: string,
): { graphId: string; archivedAt: string } {
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`);
  try {
    const state = branchesFor(workspace, graphId);
    if (!state.completed) throw new Error(`Graph must complete before archival: ${graphId}`);
    return {
      graphId,
      archivedAt: archiveOrchestrationResources(workspace, "graph", graphId, state.generation),
    };
  } finally {
    lease.release();
  }
}

export async function pruneEngineeringGraphResources(
  workspace: string,
  graphId: string,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<EngineeringGraphResourcePruneResult> {
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`);
  let resourceLease: ReturnType<typeof acquireSessionLease> | undefined;
  try {
    resourceLease = acquireManagedOrchestrationWorktreeLease(workspace);
    const { branches, generation } = branchesFor(workspace, graphId);
    if (!options.force && !orchestrationResourcesArchived(workspace, "graph", graphId, generation)) {
      throw new Error(`Graph must be archived before pruning: ${graphId}`);
    }
    const entries = branches.length === 0 ? [] : await listGitWorktrees(workspace);
    const removed: string[] = [];
    const retained: string[] = [];
    for (const branch of branches) {
      const entry = entries.find((item) => item.branch === branch);
      if (!entry) continue;
      const { physical } = resolveManagedOrchestrationWorktree(workspace, entry.path, branch);
      if ((await isWorktreeDirty(physical)) || options.dryRun) retained.push(branch);
      else {
        await removeWorktree(workspace, physical, branch);
        removed.push(branch);
      }
    }
    return { graphId, dryRun: options.dryRun === true, removed, retained };
  } finally {
    resourceLease?.release();
    lease.release();
  }
}

export async function promoteEngineeringGraphResult(
  workspace: string,
  graphId: string,
  target: string,
): Promise<{ graphId: string; target: string; branch: string }> {
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`);
  try {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) throw new Error(`Persisted Graph not found: ${graphId}`);
    const branch =
      target === "fan-in"
        ? state.fanIn?.status === "passed"
          ? state.fanIn.branch
          : undefined
        : state.results.find((result) => result.id === target && result.status === "passed")?.managedBranch;
    if (!branch) throw new Error(`Graph target is not promotable: ${target}`);
    await promoteManagedOrchestrationWorktree(workspace, branch, "Graph promotion conflict");
    return { graphId, target, branch };
  } finally {
    lease.release();
  }
}
