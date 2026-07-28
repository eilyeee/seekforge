import { isWorktreeDirty, listGitWorktrees, removeWorktree } from "../worktree.js";
import { loadLoopDagState } from "./loop-dag.js";
import {
  acquireManagedLoopWorktreeLease,
  promoteManagedLoopWorktree,
  resolveManagedLoopWorktree,
} from "./loop-managed-worktree.js";
import { acquireSessionLease, isSessionRunActive } from "./session-lease.js";
import {
  archiveOrchestrationResources,
  measureManagedWorktreeDirectory,
  orchestrationResourcesArchived,
} from "./orchestration-resources.js";

export type LoopDagResourceReport = {
  dagId: string;
  completed: boolean;
  archived: boolean;
  active: boolean;
  totalBytes: number;
  truncated: boolean;
  worktrees: Array<{ branch: string; path: string; bytes: number }>;
};

export type LoopDagResourcePruneResult = { dagId: string; dryRun: boolean; removed: string[]; retained: string[] };

function branchesFor(workspace: string, dagId: string): { completed: boolean; branches: string[] } {
  const state = loadLoopDagState(workspace, dagId);
  if (!state) throw new Error(`Persisted Loop DAG not found: ${dagId}`);
  const branches = new Set<string>();
  for (const result of state.results) {
    if (result.output?.managedBranch) branches.add(result.output.managedBranch);
  }
  if (state.fanIn?.branch) branches.add(state.fanIn.branch);
  return { completed: state.completedAt !== undefined, branches: [...branches] };
}

export async function inspectLoopDagResources(workspace: string, dagId: string): Promise<LoopDagResourceReport> {
  const { completed, branches } = branchesFor(workspace, dagId);
  if (branches.length === 0) {
    return {
      dagId,
      completed,
      archived: orchestrationResourcesArchived(workspace, "loop-dag", dagId),
      active: isSessionRunActive(workspace, `loop-dag-${dagId}`),
      totalBytes: 0,
      truncated: false,
      worktrees: [],
    };
  }
  const entries = await listGitWorktrees(workspace);
  const worktrees: LoopDagResourceReport["worktrees"] = [];
  let truncated = false;
  for (const branch of branches) {
    const entry = entries.find((item) => item.branch === branch);
    if (!entry) continue;
    const { root, physical } = resolveManagedLoopWorktree(workspace, entry.path, branch);
    const measured = measureManagedWorktreeDirectory(physical, root);
    truncated ||= measured.truncated;
    worktrees.push({ branch, path: physical, bytes: measured.bytes });
  }
  return {
    dagId,
    completed,
    archived: orchestrationResourcesArchived(workspace, "loop-dag", dagId),
    active: isSessionRunActive(workspace, `loop-dag-${dagId}`),
    totalBytes: worktrees.reduce((sum, item) => sum + item.bytes, 0),
    truncated,
    worktrees,
  };
}

export function archiveLoopDagResources(workspace: string, dagId: string): { dagId: string; archivedAt: string } {
  const lease = acquireSessionLease(workspace, `loop-dag-${dagId}`);
  try {
    const { completed } = branchesFor(workspace, dagId);
    if (!completed) throw new Error(`Loop DAG must complete before archival: ${dagId}`);
    const archivedAt = archiveOrchestrationResources(workspace, "loop-dag", dagId);
    return { dagId, archivedAt };
  } finally {
    lease.release();
  }
}

export async function pruneLoopDagResources(
  workspace: string,
  dagId: string,
  options: { dryRun?: boolean; force?: boolean } = {},
): Promise<LoopDagResourcePruneResult> {
  const lease = acquireSessionLease(workspace, `loop-dag-${dagId}`);
  let resourceLease: ReturnType<typeof acquireSessionLease> | undefined;
  try {
    resourceLease = acquireManagedLoopWorktreeLease(workspace);
    const { branches } = branchesFor(workspace, dagId);
    if (!options.force && !orchestrationResourcesArchived(workspace, "loop-dag", dagId))
      throw new Error(`Loop DAG must be archived before pruning: ${dagId}`);
    if (branches.length === 0) {
      return { dagId, dryRun: options.dryRun === true, removed: [], retained: [] };
    }
    const entries = await listGitWorktrees(workspace);
    const removed: string[] = [];
    const retained: string[] = [];
    for (const branch of branches) {
      const entry = entries.find((item) => item.branch === branch);
      if (!entry) continue;
      const { physical } = resolveManagedLoopWorktree(workspace, entry.path, branch);
      if (await isWorktreeDirty(physical)) {
        retained.push(branch);
        continue;
      }
      if (options.dryRun) retained.push(branch);
      else {
        await removeWorktree(workspace, physical, branch);
        removed.push(branch);
      }
    }
    return { dagId, dryRun: options.dryRun === true, removed, retained };
  } finally {
    resourceLease?.release();
    lease.release();
  }
}

export async function promoteLoopDagResult(
  workspace: string,
  dagId: string,
  target: string,
): Promise<{ dagId: string; target: string; branch: string }> {
  const lease = acquireSessionLease(workspace, `loop-dag-${dagId}`);
  try {
    const state = loadLoopDagState(workspace, dagId);
    if (!state) throw new Error(`Persisted Loop DAG not found: ${dagId}`);
    const branch =
      target === "fan-in"
        ? state.fanIn?.status === "passed"
          ? state.fanIn.branch
          : undefined
        : state.results.find((item) => item.id === target && item.status === "passed")?.output?.managedBranch;
    if (!branch) throw new Error(`Loop DAG target is not promotable: ${target}`);
    await promoteManagedLoopWorktree(workspace, branch, "Loop DAG promotion conflict");
    return { dagId, target, branch };
  } finally {
    lease.release();
  }
}
