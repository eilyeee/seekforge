import * as fs from "node:fs";
import * as path from "node:path";
import { isSensitiveBasename } from "@seekforge/shared";
import { ToolError } from "./errors.js";

// Re-exported so `import { isSensitiveBasename } from "@seekforge/core"` keeps
// working — the implementation moved to @seekforge/shared (browser-safe, pure)
// so shared's file-refs/workspace-dirs helpers can use it without a cycle.
export { isSensitiveBasename };

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
  const target = path.resolve(wsReal, relPath);

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
    resolved = path.join(fs.realpathSync(probe), ...tail);
  } catch {
    resolved = path.join(probe, ...tail);
  }

  if (resolved !== wsReal && !resolved.startsWith(wsReal + path.sep)) {
    throw new ToolError("outside_workspace", `Path escapes the workspace: ${relPath}`, {
      path: relPath,
      resolved,
    });
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
