/**
 * Git worktree sessions (SERVER-API.md "Worktrees").
 *
 * A worktree session is an isolated checkout under
 * `<base>/.seekforge/worktrees/<slug>` on its own branch `seekforge/<slug>`,
 * registered as a workspace (id `wt-<slug>`) so every existing `?ws=`/`ws:`
 * mechanism (REST scoping, chat runs) targets it transparently. Merge-back
 * happens in the BASE workspace with `git merge --no-ff`; a dirty worktree is
 * auto-committed first ("seekforge worktree checkpoint"). A conflicted merge
 * is always aborted — the base repo is never left mid-merge.
 *
 * Registrations live in server memory: after a restart the directories and
 * branches still exist on disk but must be recreated/cleaned up manually.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";

const execFileAsync = promisify(execFile);

/** Structured failure: rest.ts maps this to {error: {code, message}} + status. */
export class WorktreeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export type WorktreeRecord = {
  /** Workspace id (`wt-<slug>`) the worktree is registered under. */
  id: string;
  slug: string;
  branch: string;
  /** Absolute path of the worktree checkout. */
  path: string;
  /** Workspace id of the base repo this worktree was created from. */
  baseId: string;
  /** Absolute path of the base repo. */
  basePath: string;
};

export type WorktreeStatus = {
  id: string;
  branch: string;
  path: string;
  /** Uncommitted changes in the worktree (`git status --porcelain`). */
  dirty: boolean;
  /** Commits on the branch that are not on the base HEAD. */
  ahead: number;
};

export type MergeResult = { merged: true } | { conflict: true; files: string[] };

/** Spawns git (no shell) and returns trimmed stdout; failures carry stderr. */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 10_000_000, timeout: 60_000 });
    return stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const detail = (e.stderr || e.stdout || e.message || "").trim().slice(0, 500);
    throw new WorktreeError("git_error", `git ${args[0]} failed: ${detail}`, 500);
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

export class WorktreeManager {
  private readonly byId = new Map<string, WorktreeRecord>();
  // Per-base-path serialization: the slug check and `git worktree add` aren't
  // atomic, so two concurrent creates on the same base (e.g. a double-click)
  // could pick the same slug and the second `worktree add` would 500. Chain
  // creates per base so each sees the previous one's worktree/branch.
  private readonly createLocks = new Map<string, Promise<unknown>>();
  // Globally reserved slugs (the workspace id `wt-<slug>` is base-independent, so
  // per-base createLocks don't serialize two DIFFERENT bases creating the same
  // name). Held synchronously across the async git work so a concurrent create
  // can't pick the same id and orphan a worktree on the second register().
  private readonly reservedSlugs = new Set<string>();

  constructor(private readonly registry: WorkspaceRegistry) {}

  get(id: string): WorktreeRecord | undefined {
    return this.byId.get(id);
  }

  /**
   * `git worktree add .seekforge/worktrees/<slug> -b seekforge/<slug>` in the
   * base workspace, then registers the checkout as workspace `wt-<slug>`.
   */
  create(base: Workspace, name?: string): Promise<{ id: string; path: string; branch: string }> {
    const prev = this.createLocks.get(base.path) ?? Promise.resolve();
    const result = prev.then(
      () => this.createLocked(base, name),
      () => this.createLocked(base, name),
    );
    // Keep the chain alive even if this create rejects (swallow only for the lock).
    this.createLocks.set(base.path, result.catch(() => {}));
    return result;
  }

  private async createLocked(base: Workspace, name?: string): Promise<{ id: string; path: string; branch: string }> {
    if (this.byId.has(base.id)) {
      throw new WorktreeError("bad_request", "cannot create a worktree from another worktree", 400);
    }
    try {
      await git(base.path, ["rev-parse", "--is-inside-work-tree"]);
    } catch {
      throw new WorktreeError("not_a_git_repo", `workspace is not a git repository: ${base.path}`, 400);
    }

    // Pick a slug that collides with neither a registered workspace nor an
    // existing seekforge/<slug> branch.
    const wanted = worktreeSlug(name);
    let slug = wanted;
    for (let n = 2; (await this.slugTaken(base.path, slug)) && n < 100; n++) {
      slug = `${wanted}-${n}`;
    }
    // Close the await-gap: bump past any slug reserved by a concurrent create
    // (synchronously, no await) and claim it before doing the async git work.
    for (let n = 2; this.reservedSlugs.has(slug) || this.registry.resolve(`wt-${slug}`); n++) {
      slug = `${wanted}-${n}`;
    }
    this.reservedSlugs.add(slug);

    try {
      // Keep worktree checkouts out of `git status` without touching the repo's
      // .gitignore: append to .git/info/exclude (per-clone, never committed).
      await this.ensureExcluded(base.path);

      const relPath = join(".seekforge", "worktrees", slug);
      const branch = `seekforge/${slug}`;
      await git(base.path, ["worktree", "add", relPath, "-b", branch]);

      const absPath = resolve(base.path, relPath);
      const record: WorktreeRecord = {
        id: `wt-${slug}`,
        slug,
        branch,
        path: absPath,
        baseId: base.id,
        basePath: base.path,
      };
      this.registry.register({ id: record.id, path: absPath, name: slug });
      this.byId.set(record.id, record);
      return { id: record.id, path: absPath, branch };
    } finally {
      // Registered slugs stay "taken" via the registry; drop the reservation so
      // the set doesn't grow unbounded, and so a failed create frees the slug.
      this.reservedSlugs.delete(slug);
    }
  }

  /** Worktrees created from `base`, with live dirty/ahead git status. */
  async list(base: Workspace): Promise<WorktreeStatus[]> {
    const records = [...this.byId.values()].filter((r) => r.baseId === base.id);
    return Promise.all(
      records.map(async (r) => ({
        id: r.id,
        branch: r.branch,
        path: r.path,
        dirty: await this.isDirty(r.path),
        ahead: Number((await git(r.basePath, ["rev-list", "--count", `HEAD..${r.branch}`])) || "0"),
      })),
    );
  }

  /**
   * Merges the worktree branch into the base workspace's current branch with
   * `git merge --no-ff`. A dirty worktree is auto-committed first
   * ("seekforge worktree checkpoint") so nothing is lost. On conflict the
   * merge is aborted (base repo left untouched) and the conflicting files are
   * reported.
   */
  async merge(id: string): Promise<MergeResult> {
    const r = this.require(id);

    if (await this.isDirty(r.path)) {
      await git(r.path, ["add", "-A"]);
      await git(r.path, ["commit", "-m", "seekforge worktree checkpoint"]);
    }

    try {
      await git(r.basePath, ["merge", "--no-ff", r.branch, "-m", `merge ${r.branch} (seekforge worktree)`]);
      return { merged: true };
    } catch (err) {
      // Mid-merge (MERGE_HEAD exists) = a real conflict: collect the
      // conflicting files, then always abort so the base repo stays clean.
      const midMerge = await git(r.basePath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
        () => true,
        () => false,
      );
      if (!midMerge) throw err; // e.g. dirty base blocking the merge — surfaced as git_error
      const files = (await git(r.basePath, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .filter(Boolean);
      await git(r.basePath, ["merge", "--abort"]).catch(() => undefined);
      return { conflict: true, files };
    }
  }

  /** `git worktree remove --force` + branch delete + workspace unregister. */
  async remove(id: string): Promise<void> {
    const r = this.require(id);
    await git(r.basePath, ["worktree", "remove", "--force", r.path]);
    // -D: the branch may be unmerged (discard flow). Failure to delete the
    // branch is not fatal — the worktree itself is already gone.
    await git(r.basePath, ["branch", "-D", r.branch]).catch(() => undefined);
    this.registry.unregister(r.id);
    this.byId.delete(r.id);
  }

  private require(id: string): WorktreeRecord {
    const r = this.byId.get(id);
    if (!r) throw new WorktreeError("not_found", `unknown worktree: ${id}`, 404);
    return r;
  }

  private async slugTaken(basePath: string, slug: string): Promise<boolean> {
    if (this.reservedSlugs.has(slug) || this.registry.resolve(`wt-${slug}`)) return true;
    return git(basePath, ["rev-parse", "-q", "--verify", `refs/heads/seekforge/${slug}`]).then(
      () => true,
      () => false,
    );
  }

  private async isDirty(worktreePath: string): Promise<boolean> {
    return (await git(worktreePath, ["status", "--porcelain"])) !== "";
  }

  /** Appends `.seekforge/worktrees/` to `<gitdir>/info/exclude` (idempotent). */
  private async ensureExcluded(basePath: string): Promise<void> {
    const commonDir = await git(basePath, ["rev-parse", "--git-common-dir"]);
    const gitDir = isAbsolute(commonDir) ? commonDir : resolve(basePath, commonDir);
    const infoDir = join(gitDir, "info");
    const excludeFile = join(infoDir, "exclude");
    const line = ".seekforge/worktrees/";
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === line)) return;
    mkdirSync(infoDir, { recursive: true });
    appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${line}\n`);
  }
}
