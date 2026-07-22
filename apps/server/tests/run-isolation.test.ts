import { describe, expect, it, vi } from "vitest";
import type { RestContext } from "../src/routes/context.js";
import { isolateRunWorkspace } from "../src/run-isolation.js";
import type { Workspace } from "../src/workspaces.js";
import { WorktreeError } from "../src/worktrees.js";

function context(options: {
  create?: () => Promise<{ id: string; path: string; branch: string }>;
  managed?: boolean;
}): RestContext {
  return {
    worktrees: {
      get: () => (options.managed ? { id: "wt-real" } : undefined),
      create:
        options.create ??
        (async () => ({ id: "wt-created", path: "/repo/.seekforge/worktrees/created", branch: "seekforge/created" })),
    },
  } as unknown as RestContext;
}

describe("background run isolation", () => {
  it("recognizes managed worktrees by registry membership, not an id prefix", async () => {
    const create = vi.fn(async () => ({
      id: "wt-created",
      path: "/repo/.seekforge/worktrees/created",
      branch: "seekforge/created",
    }));
    const hashCollision: Workspace = { id: "wt-ovFvu", path: "/repo", name: "repo" };

    await expect(
      isolateRunWorkspace(context({ create }), hashCollision, "edit", "auto", "background"),
    ).resolves.toEqual({
      workspace: "/repo/.seekforge/worktrees/created",
      labels: {
        isolation: "worktree",
        worktreeId: "wt-created",
        worktreeBranch: "seekforge/created",
      },
    });
    expect(create).toHaveBeenCalledOnce();

    const managedCreate = vi.fn(async () => ({ id: "unused", path: "/unused", branch: "unused" }));
    await expect(
      isolateRunWorkspace(
        context({ managed: true, create: managedCreate }),
        hashCollision,
        "edit",
        "auto",
        "background",
      ),
    ).resolves.toEqual({ workspace: "/repo", labels: { isolation: "worktree" } });
    expect(managedCreate).not.toHaveBeenCalled();
  });

  it("only widens auto isolation for a non-git workspace", async () => {
    const base: Workspace = { id: "base", path: "/repo", name: "repo" };
    const notGit = new WorktreeError("not_a_git_repo", "not git", 400);
    await expect(
      isolateRunWorkspace(context({ create: async () => Promise.reject(notGit) }), base, "edit", "auto", "background"),
    ).resolves.toEqual({
      workspace: "/repo",
      labels: { isolation: "workspace", isolationFallback: "not_a_git_repo" },
    });

    for (const error of [
      new WorktreeError("git_error", "git failed", 500),
      new WorktreeError("session_busy", "busy", 409),
      new WorktreeError("bad_request", "collision", 409),
    ]) {
      await expect(
        isolateRunWorkspace(context({ create: async () => Promise.reject(error) }), base, "edit", "auto", "background"),
      ).rejects.toBe(error);
    }
  });
});
