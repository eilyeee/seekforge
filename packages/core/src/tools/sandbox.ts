import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveBasename, isSensitiveRelPath } from "@seekforge/shared";
import { normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import { ToolError } from "./errors.js";

// Re-exported so `import { isSensitiveBasename } from "@seekforge/core"` keeps
// working — the implementation moved to @seekforge/shared (browser-safe, pure)
// so shared's file-refs/workspace-dirs helpers can use it without a cycle.
export { isSensitiveBasename, isSensitiveRelPath };

/** Directories skipped by listing/search tools. */
export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "target",
  "vendor",
]);

/**
 * Resolve `relPath` against `workspace` and assert containment.
 *
 * Realpath-based: symlinks anywhere in the path are resolved (for not-yet-existing
 * paths, the deepest existing ancestor is realpathed) so symlink escapes, "..",
 * and absolute paths outside the workspace are all rejected.
 *
 * Returns the fully resolved absolute path (inside the realpathed workspace).
 */
export function resolveInsideWorkspace(workspace: string, relPath: string): string {
  const wsReal = fs.realpathSync(workspace);
  const resolved = resolvePhysicalPath(wsReal, relPath);
  if (!isWithin(resolved, wsReal)) {
    throw new ToolError("outside_workspace", `Path escapes the workspace: ${relPath}`, {
      path: relPath,
      resolved,
    });
  }
  return resolved;
}

/**
 * Where a tool path physically points (symlinks resolved), whether or not that
 * is inside the workspace. Throws on a symlink among not-yet-existing parts.
 */
export function physicalToolPath(workspace: string, relPath: string): string {
  return resolvePhysicalPath(fs.realpathSync(workspace), relPath);
}

function isWithin(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

/**
 * The physical location `relPath` names when resolved against the already
 * realpathed `rootReal`, without deciding whether that location is allowed.
 */
function resolvePhysicalPath(rootReal: string, relPath: string): string {
  const target = path.resolve(rootReal, relPath);

  // Realpath the deepest existing ancestor, then re-append the missing tail.
  let probe = target;
  const tail: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  let resolved: string;
  try {
    resolved = fs.realpathSync(probe);
  } catch {
    resolved = probe;
  }
  // Re-append the missing tail one component at a time, rejecting any symlink
  // among them. The existence probe above uses `existsSync`, which FOLLOWS
  // symlinks, so a DANGLING symlink (its target does not exist) is skipped as a
  // plain missing name — its literal path then passes the containment check,
  // after which a following write/mkdir would follow the link and escape the
  // workspace. lstat (no-follow) closes that hole.
  for (const name of tail) {
    resolved = path.join(resolved, name);
    const st = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) {
      throw new ToolError("outside_workspace", `Path escapes the workspace (symlink): ${relPath}`, {
        path: relPath,
        resolved,
      });
    }
  }
  return resolved;
}

/** Containment + sensitive-file check for read access. Returns resolved path. */
export function resolveForRead(workspace: string, relPath: string): string {
  const resolved = resolveInsideWorkspace(workspace, relPath);
  if (isSensitiveBasename(path.basename(resolved))) {
    throw new ToolError("sensitive_path", `Reading ${relPath} is not allowed (sensitive file)`, {
      path: relPath,
    });
  }
  // Secret files with a generic basename (SeekForge's own config.json /
  // triggers.json, .git/config) — blocked by workspace-relative path so the
  // model can't read the provider apiKey / webhook secrets back.
  const wsReal = fs.realpathSync(workspace);
  if (isSensitiveRelPath(path.relative(wsReal, resolved))) {
    throw new ToolError("sensitive_path", `Reading ${relPath} is not allowed (sensitive file)`, {
      path: relPath,
    });
  }
  return resolved;
}

/** Containment + .git protection for write access. Returns resolved path. */
export function resolveForWrite(workspace: string, relPath: string): string {
  const resolved = resolveInsideWorkspace(workspace, relPath);
  const wsReal = fs.realpathSync(workspace);
  const rel = path.relative(wsReal, resolved);
  if (rel === ".git" || rel.startsWith(".git" + path.sep)) {
    throw new ToolError("sensitive_path", `Writing under .git/ is not allowed: ${relPath}`, {
      path: relPath,
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Additional directories
// ---------------------------------------------------------------------------

/**
 * Validate user-granted directories against a project: each must exist, be a
 * directory, and lie outside the project (the project is already a root).
 * Returns their physical paths — a symlink rebound after the grant must not
 * move it — plus the entries that were refused.
 */
export function resolveAdditionalDirectories(
  directories: readonly string[],
  workspace: string,
): { directories: string[]; rejected: string[] } {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const entry of directories) {
    const physical = normalizeExtraDir(entry, workspace);
    if (physical === null) rejected.push(entry);
    else if (!accepted.includes(physical)) accepted.push(physical);
  }
  return { directories: accepted, rejected };
}

export type ToolPathAccess = "read" | "write" | "edit" | "list";

/**
 * Which root a file-tool path belongs to, and the path to hand that root's
 * resolvers (resolveForRead/resolveForWrite, or the runtime backend).
 *
 * Paths are relative to the workspace, as they always were; a path — usually
 * absolute — whose physical location lies in an additional directory is
 * re-rooted there, choosing the deepest root that contains it. Anything else
 * stays with the workspace, whose resolvers keep refusing it exactly as
 * before, so a session without additional directories is unchanged.
 *
 * An additional directory is often a parent of several projects rather than a
 * project itself, so its secret-file and `.git` rules apply at every depth,
 * not only at its top level.
 */
export function toolPathRoot(
  ctx: { workspace: string; additionalDirectories?: readonly string[] | undefined },
  relPath: string,
  access: ToolPathAccess,
): { root: string; path: string } {
  const unchanged = { root: ctx.workspace, path: relPath };
  const extras = ctx.additionalDirectories ?? [];
  if (extras.length === 0) return unchanged;
  let wsReal: string;
  let resolved: string;
  try {
    wsReal = fs.realpathSync(ctx.workspace);
    resolved = resolvePhysicalPath(wsReal, relPath);
  } catch {
    return unchanged;
  }
  if (isWithin(resolved, wsReal)) return unchanged;
  let best: string | undefined;
  for (const extra of extras) {
    let real: string;
    try {
      real = fs.realpathSync(extra);
    } catch {
      continue;
    }
    if (isWithin(resolved, real) && (best === undefined || real.length > best.length)) best = real;
  }
  if (best === undefined) return unchanged;
  assertNestedPathAllowed(path.relative(best, resolved), relPath, access);
  return { root: best, path: resolved };
}

/**
 * isSensitiveRelPath at any depth: `a/b/.git/config` is as secret as
 * `.git/config` — a nested project keeps its SeekForge config and git
 * credentials in the same places.
 */
export function isSensitiveNestedPath(rel: string): boolean {
  const segments = rel.split(/[\\/]/).filter((segment) => segment !== "");
  return segments.some((_, index) => isSensitiveRelPath(segments.slice(index).join("/")));
}

function assertNestedPathAllowed(rel: string, display: string, access: ToolPathAccess): void {
  const segments = rel.split(path.sep).filter((segment) => segment !== "");
  if (access === "read" || access === "edit") {
    const sensitive = isSensitiveBasename(segments.at(-1) ?? "") || isSensitiveNestedPath(rel);
    if (sensitive) {
      throw new ToolError("sensitive_path", `Reading ${display} is not allowed (sensitive file)`, { path: display });
    }
  }
  if ((access === "write" || access === "edit") && segments.includes(".git")) {
    throw new ToolError("sensitive_path", `Writing under .git/ is not allowed: ${display}`, { path: display });
  }
}
