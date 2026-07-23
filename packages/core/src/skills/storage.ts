import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireSessionLease, acquireWorkspaceSessionGuardForLease } from "../agent/session-lease.js";
import { seekforgeHome } from "../memory/store.js";

export const SKILL_ID_RE = /^(?=.{1,128}$)[a-z0-9][a-z0-9-]*$/;
export const SKILLS_MUTATION_LEASE_ID = "skills-mutation";

/** Resolve `.seekforge/skills` while rejecting linked or non-directory components. */
export function resolveSkillsStoreRoot(base: string, create: boolean): string | undefined {
  const lexicalBase = resolve(base);
  let current = realpathSync(lexicalBase);
  for (const part of [".seekforge", "skills"]) {
    current = join(current, part);
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined && create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(current, { throwIfNoEntry: false });
    }
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`skills store path must be a physical directory: ${current}`);
    }
  }
  // Preserve the caller's lexical workspace spelling in public paths. This is
  // observable on macOS, where /var is a system alias for /private/var.
  return join(lexicalBase, ".seekforge", "skills");
}

export function skillsStoreRoot(workspace: string, global: boolean, create: boolean): string | undefined {
  return resolveSkillsStoreRoot(global ? seekforgeHome() : workspace, create);
}

/** Serialize a mutation and prevent it from racing an Agent that owns the project workspace. */
export function withSkillMutation<T>(workspace: string, global: boolean, operation: () => T): T {
  const leaseWorkspace = global ? seekforgeHome() : workspace;
  const lease = acquireSessionLease(leaseWorkspace, SKILLS_MUTATION_LEASE_ID);
  let guard: ReturnType<typeof acquireWorkspaceSessionGuardForLease> | undefined;
  try {
    if (!global) guard = acquireWorkspaceSessionGuardForLease(workspace, lease);
    return operation();
  } finally {
    guard?.release();
    lease.release();
  }
}
