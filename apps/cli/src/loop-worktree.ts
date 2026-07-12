import {
  createWorktree,
  isWorktreeDirty,
  listGitWorktrees,
  worktreeBranchExists,
  worktreeSlug,
} from "@seekforge/core";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LoopWorktree = {
  path: string;
  branch: string;
};

/** Resolve a user-provided name to a unique, safe SeekForge worktree slug. */
export async function createLoopWorktree(basePath: string, name?: string): Promise<LoopWorktree> {
  const requestedSuffix = name?.replace(/^loop-/, "") ?? String(Date.now());
  const baseSlug = worktreeSlug(`loop-${requestedSuffix}`);
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

export function isRetainedLoopWorktree(basePath: string, worktree: LoopWorktree): boolean {
  const root = resolve(basePath, ".seekforge", "worktrees");
  const rel = relative(root, resolve(worktree.path));
  return worktree.branch.startsWith("seekforge/loop-") && rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function cleanupLoopWorktree(
  basePath: string,
  name: string,
  force = false,
): Promise<LoopWorktree> {
  const resolvedName = resolve(basePath, name);
  const entries = await listGitWorktrees(basePath);
  const entry = entries.find((candidate) =>
    candidate.path === resolvedName || candidate.path === name || candidate.branch === name ||
    candidate.branch === `seekforge/${name}` || candidate.path.endsWith(`${sep}${name}`),
  );
  if (!entry || !isRetainedLoopWorktree(basePath, entry)) {
    throw new Error(`Retained loop worktree not found: ${name}`);
  }
  if (!force && await isWorktreeDirty(entry.path)) {
    throw new Error(`Loop worktree has uncommitted changes: ${entry.path}\nRe-run with --force to discard them.`);
  }
  await execFileAsync(
    "git",
    ["worktree", "remove", ...(force ? ["--force"] : []), entry.path],
    { cwd: basePath, timeout: 60_000 },
  );
  await execFileAsync("git", ["branch", "-D", entry.branch], { cwd: basePath, timeout: 60_000 })
    .catch(() => undefined);
  return { path: entry.path, branch: entry.branch };
}
