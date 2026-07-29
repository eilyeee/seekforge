import { isDeepStrictEqual } from "node:util";
import type { EngineeringGraphDefinition } from "./graph-contract.js";
import { orchestrationDescendantClosure } from "./orchestration.js";

export type EngineeringGraphMigrationPlan = {
  graphId: string;
  graphPolicyChanged: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  preserved: string[];
  invalidated: string[];
};

/** Plans invalidation before any state, lease, workspace, or Git mutation. */
export function planEngineeringGraphMigration(
  before: EngineeringGraphDefinition,
  after: EngineeringGraphDefinition,
): EngineeringGraphMigrationPlan {
  if (before.graphId !== after.graphId) throw new Error("Graph migration requires the same graph id");
  const oldNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const newNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const { nodes: _beforeNodes, ...beforePolicy } = before;
  const { nodes: _afterNodes, ...afterPolicy } = after;
  const graphPolicyChanged = !isDeepStrictEqual(beforePolicy, afterPolicy);
  const added = [...newNodes.keys()].filter((id) => !oldNodes.has(id)).sort();
  const removed = [...oldNodes.keys()].filter((id) => !newNodes.has(id)).sort();
  const changed = [...newNodes.keys()]
    .filter((id) => oldNodes.has(id) && !isDeepStrictEqual(oldNodes.get(id), newNodes.get(id)))
    .sort();
  const invalidated = graphPolicyChanged
    ? [...newNodes.keys()].sort()
    : [...orchestrationDescendantClosure(after.nodes, [...added, ...changed])].sort();
  const invalidatedSet = new Set(invalidated);
  const preserved = [...newNodes.keys()].filter((id) => oldNodes.has(id) && !invalidatedSet.has(id)).sort();
  return { graphId: after.graphId, graphPolicyChanged, added, removed, changed, preserved, invalidated };
}
