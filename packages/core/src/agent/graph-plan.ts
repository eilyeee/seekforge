import type { EngineeringGraphDefinition } from "./graph-contract.js";
import { ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID, engineeringGraphNeedsAgentRuntime } from "./graph-contract.js";
import { managedOrchestrationWorktreeSlug } from "./orchestration-worktrees.js";

export type EngineeringGraphPlanNode = {
  id: string;
  path: string;
  kind: string;
  dependsOn: string[];
  workspace: string;
  managedBranch?: string;
  graph?: EngineeringGraphPlan;
};

export type EngineeringGraphPlan = {
  graphId: string;
  nodeCount: number;
  maxConcurrency: number;
  failurePolicy: "stop" | "continue";
  requiresAgentRuntime: boolean;
  waves: string[][];
  nodes: EngineeringGraphPlanNode[];
  fanInBranch?: string;
};

function graphWaves(definition: EngineeringGraphDefinition): string[][] {
  const remaining = new Map(definition.nodes.map((node) => [node.id, new Set(node.dependsOn ?? [])]));
  const waves: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
    if (ready.length === 0) break;
    waves.push(ready);
    for (const id of ready) remaining.delete(id);
    for (const dependencies of remaining.values()) for (const id of ready) dependencies.delete(id);
  }
  return waves;
}

export function planEngineeringGraph(definition: EngineeringGraphDefinition, prefix = ""): EngineeringGraphPlan {
  return {
    graphId: definition.graphId,
    nodeCount: definition.nodes.length,
    maxConcurrency: definition.maxConcurrency ?? 1,
    failurePolicy: definition.failurePolicy ?? "stop",
    requiresAgentRuntime: engineeringGraphNeedsAgentRuntime(definition),
    waves: graphWaves(definition),
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      path: `${prefix}${node.id}`,
      kind: node.kind,
      dependsOn: node.dependsOn ?? [],
      workspace: definition.managedWorktrees ? "<managed-worktree>" : (node.workspace ?? "."),
      ...(definition.managedWorktrees && node.kind !== "gate" && node.kind !== "router"
        ? {
            managedBranch: `seekforge/${managedOrchestrationWorktreeSlug("graph", definition.graphId, node.id)}`,
          }
        : {}),
      ...(node.graph ? { graph: planEngineeringGraph(node.graph, `${prefix}${node.id}/`) } : {}),
    })),
    ...(definition.fanIn
      ? {
          fanInBranch: `seekforge/${managedOrchestrationWorktreeSlug(
            "graph",
            definition.graphId,
            ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID,
          )}`,
        }
      : {}),
  };
}
