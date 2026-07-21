/**
 * Stateless git-worktree operations.
 *
 * These are the pure, path-parameterized git primitives behind SeekForge
 * "worktree sessions": an isolated checkout under
 * `<base>/.seekforge/worktrees/<slug>` on its own branch `seekforge/<slug>`.
 * They carry no workspace-registry knowledge and no HTTP semantics — callers
 * (the server's `WorktreeManager`, the TUI) layer their own bookkeeping and
 * error mapping on top. Failures surface as {@link WorktreeGitError} with a
 * `code` string; the caller maps that code to whatever it needs.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { readUtf8FileBoundedSync } from "./util/fs.js";

const execFileAsync = promisify(execFile);
const WORKTREE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_GIT_EXCLUDE_BYTES = 1024 * 1024;

/** Structured git failure; `code` is stable, the caller maps it (e.g. to HTTP status). */
export class WorktreeGitError extends Error {
  constructor(
    public readonly code: "git_error" | "not_a_git_repo",
    message: string,
  ) {
    super(message);
    this.name = "WorktreeGitError";
  }
}

/** Result of merging a worktree branch back into its base. */
export type WorktreeMergeResult = { merged: true } | { conflict: true; files: string[] };

/** One entry from `git worktree list --porcelain`. */
export type GitWorktreeEntry = {
  /** Absolute path of the checkout. */
  path: string;
  /** Branch ref with `refs/heads/` stripped, or "" when detached/bare. */
  branch: string;
  /** Commit the checkout is at, or "" for a bare entry. */
  head: string;
};

/**
 * Spawns git (no shell) and returns trimmed stdout; failures carry stderr.
 * LC_ALL=C keeps git's messages locale-independent so callers that classify
 * failures by text are not broken on non-English systems.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10_000_000,
      timeout: 60_000,
      env: { ...process.env, LC_ALL: "C" },
    });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").trim().slice(0, 500);
    throw new WorktreeGitError("git_error", `git ${args[0]} failed: ${detail}`);
  }
}

/** `name` -> a url/branch-safe slug; empty input falls back to a timestamp. */
export function worktreeSlug(name?: string, now: Date = new Date()): string {
  const fromName = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (fromName) return fromName;
  // e.g. 20260612-153000 (UTC, second precision).
  return now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** Appends `.seekforge/worktrees/` to `<git-common-dir>/info/exclude` (idempotent). */
async function ensureExcluded(basePath: string): Promise<void> {
  const commonDir = await git(basePath, ["rev-parse", "--git-common-dir"]);
  const gitDir = isAbsolute(commonDir) ? commonDir : resolve(basePath, commonDir);
  const infoDir = join(gitDir, "info");
  const excludeFile = join(infoDir, "exclude");
  const line = ".seekforge/worktrees/";
  const current = existsSync(excludeFile) ? readUtf8FileBoundedSync(excludeFile, MAX_GIT_EXCLUDE_BYTES) : "";
  if (current.split("\n").some((l) => l.trim() === line)) return;
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`);
}

function requirePhysicalDirectory(path: string, create: boolean): void {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
    }
    stat = lstatSync(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(path) !== path) {
    throw new WorktreeGitError("git_error", `unsafe worktree directory: ${path}`);
  }
}

function physicalWorktreesRoot(basePath: string): string {
  const base = realpathSync.native(resolve(basePath));
  const state = join(base, ".seekforge");
  const root = join(state, "worktrees");
  requirePhysicalDirectory(state, true);
  requirePhysicalDirectory(root, true);
  const physical = realpathSync.native(root);
  if (physical !== root || !physical.startsWith(base + sep)) {
    throw new WorktreeGitError("git_error", `worktree directory escapes base repository: ${root}`);
  }
  return root;
}

/**
 * `git worktree add .seekforge/worktrees/<slug> -b seekforge/<slug>` in the
 * base repo. Verifies `basePath` is a work tree (throws `not_a_git_repo`
 * otherwise) and keeps the checkouts out of `git status` via info/exclude.
 */
export async function createWorktree(basePath: string, slug: string): Promise<{ path: string; branch: string }> {
  if (!WORKTREE_SLUG_RE.test(slug)) {
    throw new WorktreeGitError("git_error", `invalid worktree slug: ${slug}`);
  }
  try {
    await git(basePath, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    throw new WorktreeGitError("not_a_git_repo", `not a git repository: ${basePath}`);
  }
  const root = physicalWorktreesRoot(basePath);
  const target = join(root, slug);
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) throw new WorktreeGitError("git_error", `unsafe worktree path: ${target}`);
  }
  await ensureExcluded(basePath);
  const branch = `seekforge/${slug}`;
  await git(basePath, ["worktree", "add", target, "-b", branch]);
  const physicalTarget = realpathSync.native(target);
  if (!physicalTarget.startsWith(root + sep)) {
    throw new WorktreeGitError("git_error", `worktree path escapes base repository: ${target}`);
  }
  return { path: resolve(basePath, ".seekforge", "worktrees", slug), branch };
}

/** Whether `refs/heads/seekforge/<slug>` already exists in the base repo. */
export async function worktreeBranchExists(basePath: string, slug: string): Promise<boolean> {
  return git(basePath, ["rev-parse", "-q", "--verify", `refs/heads/seekforge/${slug}`]).then(
    () => true,
    () => false,
  );
}

/** Uncommitted changes in the worktree (`git status --porcelain` non-empty). */
export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  return (await git(worktreePath, ["status", "--porcelain"])) !== "";
}

/** Commits on `branch` that are not on the base repo's current HEAD. */
export async function worktreeAhead(basePath: string, branch: string): Promise<number> {
  return Number((await git(basePath, ["rev-list", "--count", `HEAD..${branch}`])) || "0");
}

/**
 * Merges `branch` into the base repo's current branch with `git merge --no-ff`.
 * A dirty worktree is auto-committed first ("seekforge worktree checkpoint") so
 * nothing is lost. On conflict the merge is always aborted (the base repo is
 * never left mid-merge) and the conflicting files are reported. Non-conflict
 * git failures (e.g. a dirty base blocking the merge) propagate.
 */
export async function mergeWorktree(
  basePath: string,
  worktreePath: string,
  branch: string,
): Promise<WorktreeMergeResult> {
  if (await isWorktreeDirty(worktreePath)) {
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-m", "seekforge worktree checkpoint"]);
  }

  try {
    await git(basePath, ["merge", "--no-ff", branch, "-m", `merge ${branch} (seekforge worktree)`]);
    return { merged: true };
  } catch (err) {
    // Mid-merge (MERGE_HEAD exists) = a real conflict: collect the conflicting
    // files, then always abort so the base repo stays clean.
    const midMerge = await git(basePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      () => true,
      () => false,
    );
    if (!midMerge) throw err; // e.g. dirty base blocking the merge
    // Always abort, even if collecting the conflict list throws, so the base
    // repo is never left mid-merge (which blocks all later operations on it).
    try {
      const files = (await git(basePath, ["diff", "--name-only", "--diff-filter=U"])).split("\n").filter(Boolean);
      return { conflict: true, files };
    } finally {
      await git(basePath, ["merge", "--abort"]).catch(() => undefined);
    }
  }
}

/**
 * `git worktree remove --force <path>` then `git branch -D <branch>`. The branch
 * delete is best-effort: it may be unmerged (discard flow) and the checkout is
 * already gone, so its failure is not fatal.
 */
export async function removeWorktree(basePath: string, worktreePath: string, branch: string): Promise<void> {
  await git(basePath, ["worktree", "remove", "--force", worktreePath]);
  await git(basePath, ["branch", "-D", branch]).catch(() => undefined);
}

/**
 * Parses `git worktree list --porcelain -z` into every worktree of `basePath`
 * (including the main checkout). Callers filter as needed (e.g. to
 * `seekforge/` branches). Branch refs are returned with `refs/heads/` stripped.
 */
export async function listGitWorktrees(basePath: string): Promise<GitWorktreeEntry[]> {
  const out = await git(basePath, ["worktree", "list", "--porcelain", "-z"]);
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | undefined;
  for (const field of out.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice("worktree ".length), branch: "", head: "" };
      entries.push(current);
    } else if (!current) {
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
    // `detached`/`bare`/`locked`/`prunable` lines leave branch/head as-is.
  }
  return entries;
}
