import { sep } from "node:path";
import { isWorktreeDirty, listGitWorktrees, removeWorktree } from "../worktree.js";
import { listEngineeringGraphStates, loadEngineeringGraphState, removeEngineeringGraphState } from "./graph-state.js";
import {
  ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID,
  engineeringSubgraphStateId,
  graphNodeIsEffectful,
  type EngineeringGraphDefinition,
} from "./graph-contract.js";
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

export type EngineeringGraphRetentionResult = { removed: string[]; retained: string[] };

function branchesFor(
  workspace: string,
  graphId: string,
): { completed: boolean; generation: string; branches: string[] } {
  const state = loadEngineeringGraphState(workspace, graphId);
  if (!state) throw new Error(`Persisted Graph not found: ${graphId}`);
  const branches = new Set(state.results.flatMap((result) => (result.managedBranch ? [result.managedBranch] : [])));
  if (state.definition.managedWorktrees) {
    for (const node of state.definition.nodes) {
      if (graphNodeIsEffectful(node)) {
        branches.add(`seekforge/${managedOrchestrationWorktreeSlug("graph", graphId, node.id)}`);
      }
    }
    if (state.definition.fanIn) {
      branches.add(
        `seekforge/${managedOrchestrationWorktreeSlug("graph", graphId, ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID)}`,
      );
    }
  }
  const addNestedBranches = (definition: EngineeringGraphDefinition, ownerId: string): void => {
    for (const node of definition.nodes) {
      if (!node.graph) continue;
      const childId = engineeringSubgraphStateId(ownerId, node.id, node.graph.graphId);
      if (node.graph.managedWorktrees) {
        for (const child of node.graph.nodes) {
          if (graphNodeIsEffectful(child)) {
            branches.add(`seekforge/${managedOrchestrationWorktreeSlug("graph", childId, child.id)}`);
          }
        }
        if (node.graph.fanIn) {
          branches.add(
            `seekforge/${managedOrchestrationWorktreeSlug("graph", childId, ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID)}`,
          );
        }
      }
      addNestedBranches(node.graph, childId);
    }
  };
  addNestedBranches(state.definition, graphId);
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
  const targets = branches.flatMap((branch) => {
    const entry = entries.find((item) => item.branch === branch);
    if (!entry) return [];
    const { root, physical } = resolveManagedOrchestrationWorktree(workspace, entry.path, branch);
    return [{ branch, root, physical }];
  });
  for (const { branch, root, physical } of targets) {
    const descendants = new Set(
      targets
        .map((target) => target.physical)
        .filter((candidate) => candidate !== physical && candidate.startsWith(`${physical}${sep}`)),
    );
    const measured = measureManagedWorktreeDirectory(physical, root, 100_000, descendants);
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
    const retainedPaths: string[] = [];
    const targets = branches
      .flatMap((branch) => {
        const entry = entries.find((item) => item.branch === branch);
        if (!entry) return [];
        const { physical } = resolveManagedOrchestrationWorktree(workspace, entry.path, branch);
        return [{ branch, physical }];
      })
      .sort((left, right) => right.physical.length - left.physical.length);
    for (const { branch, physical } of targets) {
      if (
        options.dryRun ||
        retainedPaths.some((path) => path.startsWith(`${physical}${sep}`)) ||
        (await isWorktreeDirty(physical))
      ) {
        retained.push(branch);
        retainedPaths.push(physical);
      } else {
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

/** Opt-in terminal-state retention; resumable, active, recent, and dirty-resource Graphs are retained. */
export async function pruneEngineeringGraphStates(
  workspace: string,
  options: { maxAgeDays?: number; maxTerminalCount?: number; dryRun?: boolean } = {},
): Promise<EngineeringGraphRetentionResult> {
  const maxAgeDays = options.maxAgeDays ?? 30;
  const maxTerminalCount = options.maxTerminalCount ?? 100;
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0 || maxAgeDays > 3_650) {
    throw new RangeError("Graph maxAgeDays must be 0 to 3650");
  }
  if (!Number.isSafeInteger(maxTerminalCount) || maxTerminalCount < 0 || maxTerminalCount > 10_000) {
    throw new RangeError("Graph maxTerminalCount must be 0 to 10000");
  }
  const states = listEngineeringGraphStates(workspace);
  const terminal = states
    .filter(
      (state) =>
        state.parentGraph === undefined &&
        state.completedAt !== undefined &&
        !isSessionRunActive(workspace, `engineering-graph-${state.graphId}`),
    )
    .sort((left, right) => Date.parse(right.completedAt!) - Date.parse(left.completedAt!));
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1_000;
  const eligible = terminal.filter(
    (state, index) => index >= maxTerminalCount || Date.parse(state.completedAt!) < cutoff,
  );
  const removed: string[] = [];
  const retained: string[] = [];
  for (const state of eligible) {
    if (options.dryRun) {
      retained.push(state.graphId);
      continue;
    }
    try {
      const resources = await inspectEngineeringGraphResources(workspace, state.graphId);
      if (resources.worktrees.length > 0) {
        if (!resources.archived) archiveEngineeringGraphResources(workspace, state.graphId);
        const pruned = await pruneEngineeringGraphResources(workspace, state.graphId);
        if (pruned.retained.length > 0) {
          retained.push(state.graphId);
          continue;
        }
      }
      const descendants = new Set<string>();
      let frontier = [state.graphId];
      while (frontier.length > 0) {
        const owners = new Set(frontier);
        frontier = states
          .filter((candidate) => candidate.parentGraph && owners.has(candidate.parentGraph.graphId))
          .map((candidate) => candidate.graphId)
          .filter((graphId) => !descendants.has(graphId));
        for (const graphId of frontier) descendants.add(graphId);
      }
      for (const graphId of [...descendants].reverse()) removeEngineeringGraphState(workspace, graphId);
      if (removeEngineeringGraphState(workspace, state.graphId)) removed.push(state.graphId);
      else retained.push(state.graphId);
    } catch {
      retained.push(state.graphId);
    }
  }
  return { removed, retained };
}
