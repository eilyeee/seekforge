import type { RestContext } from "./routes/context.js";
import type { Workspace } from "./workspaces.js";
import { WorktreeError } from "./worktrees.js";

export type RunIsolation = "auto" | "workspace" | "worktree";

export type IsolatedRunWorkspace = {
  workspace: string;
  labels: Record<string, string>;
};

/**
 * Writable detached jobs default to a dedicated git worktree. Non-git
 * workspaces keep their previous serialized workspace execution under `auto`;
 * an explicit `worktree` request fails instead of silently widening isolation.
 */
export async function isolateRunWorkspace(
  rest: RestContext,
  base: Workspace,
  mode: "ask" | "edit",
  isolation: RunIsolation,
  name: string,
): Promise<IsolatedRunWorkspace> {
  if (mode === "ask" || isolation === "workspace" || base.id.startsWith("wt-")) {
    return { workspace: base.path, labels: { isolation: base.id.startsWith("wt-") ? "worktree" : "workspace" } };
  }
  try {
    const worktree = await rest.worktrees.create(base, name);
    return {
      workspace: worktree.path,
      labels: {
        isolation: "worktree",
        worktreeId: worktree.id,
        worktreeBranch: worktree.branch,
      },
    };
  } catch (error) {
    if (isolation !== "auto" || !(error instanceof WorktreeError)) throw error;
    return {
      workspace: base.path,
      labels: { isolation: "workspace", isolationFallback: error.code },
    };
  }
}
