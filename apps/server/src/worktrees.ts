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
 * The stateless git primitives live in `@seekforge/core`; this module keeps the
 * server-coupled bookkeeping: the workspace registry, the in-memory `byId` map,
 * `wt-<slug>` ids, per-base create serialization, and HTTP status mapping.
 *
 * Registrations live in server memory: after a restart the directories and
 * branches still exist on disk but must be recreated/cleaned up manually.
 */

import {
  createWorktree,
  acquireWorkspaceSessionGuard,
  isWorktreeDirty,
  mergeWorktree,
  removeWorktree,
  worktreeAhead,
  worktreeBranchExists,
  WorktreeGitError,
  SessionBusyError,
  worktreeSlug,
  type WorktreeMergeResult,
} from "@seekforge/core";
import type { Workspace, WorkspaceRegistry } from "./workspaces.js";
import type { ServerCoordinator } from "./coordinator.js";

// `worktreeSlug` now lives in core; re-export so existing importers keep working.
export { worktreeSlug };

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

/** Core git-error code -> HTTP status; anything unknown is a 500. */
const CORE_STATUS: Record<string, number> = { git_error: 500, not_a_git_repo: 400 };

/** Runs a core git op, remapping {@link WorktreeGitError} to {@link WorktreeError}. */
async function delegate<T>(op: Promise<T>): Promise<T> {
  try {
    return await op;
  } catch (err) {
    if (err instanceof WorktreeGitError) {
      throw new WorktreeError(err.code, err.message, CORE_STATUS[err.code] ?? 500);
    }
    throw err;
  }
}

export type MergeResult = WorktreeMergeResult;

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

export class WorktreeManager {
  private readonly byId = new Map<string, WorktreeRecord>();
  private readonly operationLocks = new Map<string, Promise<unknown>>();
  // Globally reserved slugs (the workspace id `wt-<slug>` is base-independent, so
  // per-base createLocks don't serialize two DIFFERENT bases creating the same
  // name). Held synchronously across the async git work so a concurrent create
  // can't pick the same id and orphan a worktree on the second register().
  private readonly reservedSlugs = new Set<string>();

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly coordinator: ServerCoordinator,
  ) {}

  get(id: string): WorktreeRecord | undefined {
    return this.byId.get(id);
  }

  /**
   * `git worktree add .seekforge/worktrees/<slug> -b seekforge/<slug>` in the
   * base workspace, then registers the checkout as workspace `wt-<slug>`.
   */
  create(base: Workspace, name?: string): Promise<{ id: string; path: string; branch: string }> {
    return this.coordinator.withRepository(base.path, () =>
      this.withWorkspaceGuards([base.path], base.id, () => this.createLocked(base, name)));
  }

  private async createLocked(base: Workspace, name?: string): Promise<{ id: string; path: string; branch: string }> {
    if (this.byId.has(base.id)) {
      throw new WorktreeError("bad_request", "cannot create a worktree from another worktree", 400);
    }

    // Pick a slug that collides with neither a registered workspace nor an
    // existing seekforge/<slug> branch.
    const wanted = worktreeSlug(name);
    let slug = wanted;
    // `n <= 100` so the final probe checks whether the candidate we settle on
    // (`wanted-100`) is actually free rather than exiting on a slug still taken.
    for (let n = 2; (await this.slugTaken(base.path, slug)) && n <= 100; n++) {
      slug = `${wanted}-${n}`;
    }
    // Close the await-gap: bump past any slug reserved by a concurrent create
    // (synchronously, no await) and claim it before doing the async git work.
    // Bounded so a saturated namespace surfaces an error instead of spinning the
    // event loop forever (this loop never awaits).
    for (let n = 2; this.reservedSlugs.has(slug) || this.registry.resolve(`wt-${slug}`); n++) {
      if (n > 1000) {
        throw new WorktreeError("bad_request", `too many worktrees named "${wanted}"`, 409);
      }
      slug = `${wanted}-${n}`;
    }
    this.reservedSlugs.add(slug);

    try {
      const { path: absPath, branch } = await delegate(createWorktree(base.path, slug));
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
    return this.coordinator.withRepository(base.path, async () => {
      const records = [...this.byId.values()].filter((r) => r.baseId === base.id);
      return Promise.all(
        records.map(async (r) => ({
          id: r.id,
          branch: r.branch,
          path: r.path,
          dirty: await delegate(isWorktreeDirty(r.path)),
          ahead: await delegate(worktreeAhead(r.basePath, r.branch)),
        })),
      );
    });
  }

  /**
   * Merges the worktree branch into the base workspace's current branch with
   * `git merge --no-ff`. A dirty worktree is auto-committed first
   * ("seekforge worktree checkpoint") so nothing is lost. On conflict the
   * merge is aborted (base repo left untouched) and the conflicting files are
   * reported.
   */
  async merge(id: string): Promise<MergeResult> {
    return this.withLock(this.operationLocks, id, async () => {
      const r = this.require(id);
      return this.coordinator.withRepository(r.basePath, async () => {
        return this.withWorkspaceGuards(
          [r.basePath, r.path],
          r.id,
          () => delegate(mergeWorktree(r.basePath, r.path, r.branch)),
        );
      });
    });
  }

  /** `git worktree remove --force` + branch delete + workspace unregister. */
  async remove(id: string): Promise<void> {
    await this.withLock(this.operationLocks, id, async () => {
      const r = this.require(id);
      await this.coordinator.withRepository(r.basePath, () =>
        this.withWorkspaceGuards([r.basePath, r.path], r.id, async () => {
          await delegate(removeWorktree(r.basePath, r.path, r.branch));
          this.registry.unregister(r.id);
          this.byId.delete(r.id);
        }),
      );
    });
  }

  private async withWorkspaceGuards<T>(
    workspaces: string[],
    operationId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const guards = [];
    try {
      for (const workspace of [...new Set(workspaces)].sort()) {
        guards.push(acquireWorkspaceSessionGuard(workspace));
      }
      return await operation();
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      throw new WorktreeError(
        "session_busy",
        `cannot modify worktree ${operationId} while its worktree or base workspace has an active session`,
        409,
      );
    } finally {
      for (const guard of guards.reverse()) guard.release();
    }
  }

  private withLock<T>(
    locks: Map<string, Promise<unknown>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.catch(() => {});
    locks.set(key, tail);
    void tail.finally(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return result;
  }

  private require(id: string): WorktreeRecord {
    const r = this.byId.get(id);
    if (!r) throw new WorktreeError("not_found", `unknown worktree: ${id}`, 404);
    return r;
  }

  private async slugTaken(basePath: string, slug: string): Promise<boolean> {
    if (this.reservedSlugs.has(slug) || this.registry.resolve(`wt-${slug}`)) return true;
    return delegate(worktreeBranchExists(basePath, slug));
  }
}
