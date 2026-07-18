import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireSessionLease, SessionBusyError, type SessionLease } from "@seekforge/core";

const execFileAsync = promisify(execFile);
const AGENT_MUTATION_LOCK_ID = "coord-server-agent-edit";

/** Physical identity shared by a repository and all of its linked worktrees. */
export async function canonicalRepositoryKey(workspace: string): Promise<string> {
  let commonDir: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 1_000_000,
    });
    commonDir = stdout.trim();
  } catch (error) {
    // A clean git exit means this is an ordinary non-repository workspace.
    // Spawn, timeout, and transport failures must not silently choose a weaker
    // lock key that can run concurrently with another linked worktree.
    if (typeof (error as NodeJS.ErrnoException).code !== "number") throw error;
    return `workspace:${await realpath(workspace)}`;
  }
  return `git:${await realpath(resolve(workspace, commonDir))}`;
}

/** Shared repository serialization and lifecycle tracking for one server. */
export class ServerCoordinator {
  private readonly repositoryLocks = new Map<string, Promise<unknown>>();
  private readonly operations = new Set<Promise<unknown>>();

  track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    const remove = (): void => {
      this.operations.delete(operation);
    };
    void operation.then(remove, remove);
    return operation;
  }

  withRepository<T>(workspace: string, operation: () => Promise<T>): Promise<T> {
    return this.track(
      (async () => {
        const key = await canonicalRepositoryKey(workspace);
        const previous = this.repositoryLocks.get(key) ?? Promise.resolve();
        const result = previous.then(operation, operation);
        const tail = result.catch(() => {});
        this.repositoryLocks.set(key, tail);
        void tail.then(() => {
          if (this.repositoryLocks.get(key) === tail) this.repositoryLocks.delete(key);
        });
        return result;
      })(),
    );
  }

  /** Serialize writable Agent/Loop runs across server processes for one workspace. */
  withAgentMutation<T>(workspace: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return this.withRepository(workspace, async () => {
      let lease: SessionLease;
      for (;;) {
        signal?.throwIfAborted();
        try {
          lease = acquireSessionLease(workspace, AGENT_MUTATION_LOCK_ID);
          break;
        } catch (error) {
          if (!(error instanceof SessionBusyError)) throw error;
          await delay(25, undefined, signal ? { signal } : undefined);
        }
      }
      try {
        signal?.throwIfAborted();
        return await operation();
      } finally {
        lease.release();
      }
    });
  }

  async drain(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }
}
