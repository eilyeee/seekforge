import {
  createWorktree,
  hasActiveLoopLease,
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
  branchRemoved?: boolean;
};

export type LoopRepository = {
  basePath: string;
  workspaces: string[];
};

/** Resolve a subdirectory or retained worktree back to the repository's base checkout. */
export async function resolveLoopRepository(path: string): Promise<LoopRepository> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path,
    timeout: 10_000,
  });
  const currentRoot = stdout.trim();
  const entries = await listGitWorktrees(currentRoot);
  // Git documents the main worktree as the first porcelain entry.
  const base = entries[0]?.path ?? currentRoot;
  const workspaces = [
    base,
    ...entries
      .filter((entry) => isRetainedLoopWorktree(base, entry))
      .map((entry) => entry.path),
  ];
  return { basePath: base, workspaces: [...new Set(workspaces)] };
}

/** Resolve a user-provided name to a unique, safe SeekForge worktree slug. */
export async function createLoopWorktree(basePath: string, name?: string): Promise<LoopWorktree> {
  basePath = (await resolveLoopRepository(basePath)).basePath;
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
  basePath = (await resolveLoopRepository(basePath)).basePath;
  const resolvedName = resolve(basePath, name);
  const entries = await listGitWorktrees(basePath);
  const entry = entries.find((candidate) =>
    candidate.path === resolvedName || candidate.path === name || candidate.branch === name ||
    candidate.branch === `seekforge/${name}` || candidate.path.endsWith(`${sep}${name}`),
  );
  if (!entry || !isRetainedLoopWorktree(basePath, entry)) {
    throw new Error(`Retained loop worktree not found: ${name}`);
  }
  if (hasActiveLoopLease(entry.path)) {
    throw new Error(`Loop worktree has an active loop and cannot be removed: ${entry.path}`);
  }
  if (!force && await isWorktreeDirty(entry.path)) {
    throw new Error(`Loop worktree has uncommitted changes: ${entry.path}\nRe-run with --force to discard them.`);
  }
  await execFileAsync(
    "git",
    ["worktree", "remove", ...(force ? ["--force"] : []), entry.path],
    { cwd: basePath, timeout: 60_000 },
  );
  const branchRemoved = await execFileAsync(
    "git",
    ["branch", "-D", entry.branch],
    { cwd: basePath, timeout: 60_000 },
  ).then(() => true, () => false);
  return { path: entry.path, branch: entry.branch, branchRemoved };
}
