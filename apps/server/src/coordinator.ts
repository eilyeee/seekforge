import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Physical identity shared by a repository and all of its linked worktrees. */
export async function canonicalRepositoryKey(workspace: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-common-dir"], {
      cwd: workspace,
      timeout: 10_000,
      maxBuffer: 1_000_000,
    });
    return `git:${await realpath(resolve(workspace, stdout.trim()))}`;
  } catch {
    // Non-Git workspaces still need a stable serialization key for failed or
    // partially initialized repository operations.
    try {
      return `workspace:${await realpath(workspace)}`;
    } catch {
      return `workspace:${resolve(workspace)}`;
    }
  }
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
    return this.track((async () => {
      const key = await canonicalRepositoryKey(workspace);
      const previous = this.repositoryLocks.get(key) ?? Promise.resolve();
      const result = previous.then(operation, operation);
      const tail = result.catch(() => {});
      this.repositoryLocks.set(key, tail);
      void tail.then(() => {
        if (this.repositoryLocks.get(key) === tail) this.repositoryLocks.delete(key);
      });
      return result;
    })());
  }

  async drain(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled([...this.operations]);
    }
  }
}
