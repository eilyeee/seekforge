import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createWorktree, listGitWorktrees, removeWorktree, worktreeSlug } from "../worktree.js";

export type ManagedOrchestrationWorktree = { path: string; branch: string; created: boolean };

export function managedOrchestrationWorktreeSlug(kind: "dag" | "graph", seed: string, nodeId: string): string {
  const suffixInput = kind === "dag" ? `${seed}:${nodeId}` : `${kind}:${seed}:${nodeId}`;
  const suffix = createHash("sha256").update(suffixInput).digest("hex").slice(0, 10);
  const prefix = worktreeSlug(`${kind}-${seed}-${nodeId}`).slice(0, 52).replace(/-+$/, "");
  return `${prefix}-${suffix}`;
}

export function managedOrchestrationWorktreePath(
  workspace: string,
  kind: "dag" | "graph",
  seed: string,
  nodeId: string,
): string {
  return join(
    realpathSync.native(workspace),
    ".seekforge",
    "worktrees",
    managedOrchestrationWorktreeSlug(kind, seed, nodeId),
  );
}

export async function prepareManagedOrchestrationWorktrees(
  workspace: string,
  nodeIds: readonly string[],
  kind: "dag" | "graph",
  seed: string,
  resume: boolean,
): Promise<Map<string, ManagedOrchestrationWorktree>> {
  const existing = resume ? await listGitWorktrees(workspace) : [];
  const byBranch = new Map(existing.map((entry) => [entry.branch, entry.path]));
  const result = new Map<string, ManagedOrchestrationWorktree>();
  try {
    for (const nodeId of nodeIds) {
      const slug = managedOrchestrationWorktreeSlug(kind, seed, nodeId);
      const branch = `seekforge/${slug}`;
      const retained = byBranch.get(branch);
      if (retained) {
        const physical = realpathSync.native(retained);
        const expected = managedOrchestrationWorktreePath(workspace, kind, seed, nodeId);
        if (physical !== expected) {
          throw new Error(`Managed ${kind} worktree is outside its expected path for node ${nodeId}: ${physical}`);
        }
        result.set(nodeId, { path: physical, branch, created: false });
        continue;
      }
      if (resume) throw new Error(`Managed ${kind} worktree is missing for node ${nodeId}: ${branch}`);
      const created = await createWorktree(workspace, slug);
      result.set(nodeId, { ...created, path: realpathSync.native(created.path), created: true });
    }
    return result;
  } catch (error) {
    for (const entry of [...result.values()].reverse()) {
      if (entry.created) await removeWorktree(workspace, entry.path, entry.branch).catch(() => undefined);
    }
    throw error;
  }
}
