import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { listGitWorktrees, mergeWorktree } from "../worktree.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";

export const MANAGED_LOOP_BRANCH_RE = /^seekforge\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MANAGED_WORKTREE_LEASE_ID = "loop-dag-managed-worktrees";

export function acquireManagedLoopWorktreeLease(workspace: string): SessionLease {
  return acquireSessionLease(workspace, MANAGED_WORKTREE_LEASE_ID);
}

/** Rebinds a retained worktree to its physical path beneath the managed root. */
export function resolveManagedLoopWorktree(
  workspace: string,
  path: string,
  branch: string,
): { root: string; physical: string } {
  if (!MANAGED_LOOP_BRANCH_RE.test(branch)) throw new Error(`Invalid managed Loop branch: ${branch}`);
  const root = realpathSync.native(join(realpathSync.native(workspace), ".seekforge", "worktrees"));
  const physical = realpathSync.native(path);
  if (!physical.startsWith(`${root}${sep}`)) {
    throw new Error(`Managed Loop worktree escapes its root: ${branch}`);
  }
  return { root, physical };
}

/** Promotes one typed managed branch under the repository-wide resource lease. */
export async function promoteManagedLoopWorktree(
  workspace: string,
  branch: string,
  conflictLabel: string,
): Promise<void> {
  const lease = acquireManagedLoopWorktreeLease(workspace);
  try {
    const entry = (await listGitWorktrees(workspace)).find((item) => item.branch === branch);
    if (!entry) throw new Error(`Managed Loop worktree is missing: ${branch}`);
    const { physical } = resolveManagedLoopWorktree(workspace, entry.path, branch);
    const merged = await mergeWorktree(workspace, physical, branch);
    if ("conflict" in merged) {
      throw new Error(`${conflictLabel}: ${merged.files.slice(0, 32).join(", ")}`);
    }
  } finally {
    lease.release();
  }
}
