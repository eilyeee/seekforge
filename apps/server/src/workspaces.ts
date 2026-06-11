/**
 * Workspace registry — one `seekforge serve` may host several workspaces.
 *
 * Each entry has a short stable id (a hash/slug of the absolute path) so that
 * REST routes (`?ws=<id>`) and WS start frames (`ws:<id>`) can target a specific
 * workspace. A single-workspace server (the original contract) is just a
 * one-entry registry whose first id is the default when `?ws=` is omitted.
 */

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export type Workspace = {
  /** Short stable slug derived from the absolute path. */
  id: string;
  /** Absolute path of the workspace root. */
  path: string;
  /** Display name (basename of the path). */
  name: string;
};

/** Short, stable, filesystem/url-safe id for an absolute path. */
function workspaceId(absPath: string): string {
  return createHash("sha256").update(absPath).digest("base64url").slice(0, 8);
}

/**
 * Builds an ordered registry from absolute (or relative) paths. Paths are
 * resolved to absolute and de-duplicated (first occurrence wins). At least one
 * path must be provided.
 */
export function createWorkspaceRegistry(paths: string[]): WorkspaceRegistry {
  const seen = new Set<string>();
  const workspaces: Workspace[] = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    workspaces.push({ id: workspaceId(abs), path: abs, name: basename(abs) || abs });
  }
  if (workspaces.length === 0) {
    throw new Error("at least one workspace is required");
  }
  return new WorkspaceRegistry(workspaces);
}

export class WorkspaceRegistry {
  private readonly byId: Map<string, Workspace>;

  constructor(public readonly list: readonly Workspace[]) {
    this.byId = new Map(list.map((w) => [w.id, w]));
  }

  /** The default workspace used when `?ws=`/`ws:` is omitted (the first one). */
  get default(): Workspace {
    return this.list[0]!;
  }

  /** Public view for GET /api/workspaces and GET /api/health. */
  get summary(): Array<{ id: string; name: string; path: string }> {
    return this.list.map(({ id, name, path }) => ({ id, name, path }));
  }

  /**
   * Resolves a `?ws=`/`ws:` id to a workspace. An empty/undefined id selects the
   * default (back-compat); an unknown id returns undefined (callers -> 404).
   */
  resolve(id: string | null | undefined): Workspace | undefined {
    if (id === null || id === undefined || id === "") return this.default;
    return this.byId.get(id);
  }
}
