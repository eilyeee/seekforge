import { isAbsolute, relative, sep } from "node:path";
import { isDenseArray } from "@seekforge/shared";

export type OrchestrationNodeRef = { id: string; dependsOn?: readonly string[] };

/** Returns an ISO timestamp strictly newer than a previously persisted version. */
export function nextOrchestrationVersion(previous: string, now = new Date().toISOString()): string {
  return new Date(Math.max(Date.parse(now), Date.parse(previous) + 1)).toISOString();
}

/**
 * Array inputs crossing a runtime boundary must own every indexed entry. The
 * implementation lives in `@seekforge/shared` because the protocol decoders
 * there need the same guard and cannot depend on core; this stays core's name
 * for it.
 */
export { isDenseArray };

export function validateOrchestrationSelection(
  value: unknown,
  options: {
    label: string;
    max: number;
    knownIds: ReadonlySet<string>;
    isValidId: (value: unknown) => value is string;
    allowUndefined?: boolean;
    allowEmpty?: boolean;
  },
): string[] {
  if (value === undefined && options.allowUndefined) return [];
  if (
    !isDenseArray(value) ||
    value.length > options.max ||
    (!options.allowEmpty && value.length === 0) ||
    !value.every(options.isValidId) ||
    new Set(value).size !== value.length ||
    value.some((id) => !options.knownIds.has(id))
  ) {
    throw new Error(`${options.label} must contain unique existing node ids`);
  }
  return [...value] as string[];
}

/** Includes every selected node and all of its transitive dependants. */
export function orchestrationDescendantClosure(
  nodes: readonly OrchestrationNodeRef[],
  selected: readonly string[],
): Set<string> {
  const invalidated = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!invalidated.has(node.id) && (node.dependsOn ?? []).some((dependency) => invalidated.has(dependency))) {
        invalidated.add(node.id);
        changed = true;
      }
    }
  }
  return invalidated;
}

/** True when `nodeId` transitively depends on `ancestorId`. */
export function orchestrationDependsOn(
  nodes: readonly OrchestrationNodeRef[],
  nodeId: string,
  ancestorId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const pending = [...(byId.get(nodeId)?.dependsOn ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === ancestorId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(byId.get(current)?.dependsOn ?? []));
  }
  return false;
}

export function orchestrationPathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const isDescendant = (candidate: string): boolean =>
    candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate);
  return isDescendant(leftToRight) || isDescendant(rightToLeft);
}

export function assertNonOverlappingOrchestrationPaths(paths: readonly string[], message: string): void {
  for (let left = 0; left < paths.length; left++) {
    for (let right = left + 1; right < paths.length; right++) {
      if (orchestrationPathsOverlap(paths[left]!, paths[right]!)) throw new Error(message);
    }
  }
}

export {
  isValidOrchestrationResourceId,
  orchestrationResourcesOverlap,
  selectOrchestrationReadyNodes,
  type OrchestrationRunningReservation,
  type OrchestrationScheduleCandidate,
} from "./orchestration-scheduler.js";
