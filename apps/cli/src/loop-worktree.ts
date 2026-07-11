import { createWorktree, worktreeBranchExists, worktreeSlug } from "@seekforge/core";

export type LoopWorktree = {
  path: string;
  branch: string;
};

/** Resolve a user-provided name to a unique, safe SeekForge worktree slug. */
export async function createLoopWorktree(basePath: string, name?: string): Promise<LoopWorktree> {
  const baseSlug = worktreeSlug(name === undefined ? `loop-${Date.now()}` : name);
  let slug = baseSlug;
  let suffix = 2;
  while (await worktreeBranchExists(basePath, slug)) {
    slug = `${baseSlug.slice(0, Math.max(1, 40 - String(suffix).length - 1))}-${suffix}`;
    suffix++;
  }
  return createWorktree(basePath, slug);
}

export function formatLoopWorktree(worktree: LoopWorktree): string {
  return `Loop worktree retained for inspection:\n  path: ${worktree.path}\n  branch: ${worktree.branch}`;
}
