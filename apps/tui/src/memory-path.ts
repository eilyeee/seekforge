import { isAbsolute, relative, resolve } from "node:path";

/** True when `child` is `parent` or nested anywhere below it. */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a `/memory edit [file]` target and confine it to the memory dir.
 * Returns null on traversal/sibling-prefix escapes.
 */
export function resolveMemoryEditTarget(memoryDir: string, defaultFile: string, fileArg: string): string | null {
  const root = resolve(memoryDir);
  const target = fileArg.trim() === "" ? resolve(defaultFile) : resolve(root, fileArg);
  return isInside(target, root) ? target : null;
}
