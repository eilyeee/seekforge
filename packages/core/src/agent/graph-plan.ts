import type { EngineeringGraphDefinition } from "./graph-contract.js";
import {
  ENGINEERING_GRAPH_FAN_IN_WORKTREE_ID,
  engineeringGraphNeedsAgentRuntime,
  graphNodeIsEffectful,
} from "./graph-contract.js";
import { managedOrchestrationWorktreeSlug } from "./orchestration-worktrees.js";

export type EngineeringGraphPlanNode = {
  id: string;
  path: string;
  kind: string;
  dependsOn: string[];
  workspace: string;
  managedBranch?: string;
  priority: number;
  maxAttempts: number;
  dynamicItems?: number;
  inputBindings: string[];
  graph?: EngineeringGraphPlan;
};

export type EngineeringGraphPlan = {
  graphId: string;
  nodeCount: number;
  maxConcurrency: number;
  failurePolicy: "stop" | "continue";
  requiresAgentRuntime: boolean;
  waves: string[][];
  criticalPath: string[];
  maxParallelWidth: number;
  maxAttempts: number;
  maxDynamicItems: number;
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

function graphCriticalPath(definition: EngineeringGraphDefinition): string[] {
  const paths = new Map<string, string[]>();
  for (const wave of graphWaves(definition)) {
    for (const id of wave) {
      const node = definition.nodes.find((candidate) => candidate.id === id)!;
      const parent =
        (node.dependsOn ?? [])
          .map((dependency) => paths.get(dependency) ?? [])
          .sort((left, right) => right.length - left.length)[0] ?? [];
      paths.set(id, [...parent, id]);
    }
  }
  return [...paths.values()].sort((left, right) => right.length - left.length)[0] ?? [];
}

export function planEngineeringGraph(definition: EngineeringGraphDefinition, prefix = ""): EngineeringGraphPlan {
  const waves = graphWaves(definition);
  return {
    graphId: definition.graphId,
    nodeCount: definition.nodes.length,
    maxConcurrency: definition.maxConcurrency ?? 1,
    failurePolicy: definition.failurePolicy ?? "stop",
    requiresAgentRuntime: engineeringGraphNeedsAgentRuntime(definition),
    waves,
    criticalPath: graphCriticalPath(definition),
    maxParallelWidth: Math.min(definition.maxConcurrency ?? 1, Math.max(...waves.map((wave) => wave.length))),
    maxAttempts: definition.nodes.reduce((total, node) => total + (node.maxRetries ?? 0) + 1, 0),
    maxDynamicItems: definition.nodes.reduce(
      (total, node) => total + (node.kind === "map" ? (node.maxItems ?? 32) : 0),
      0,
    ),
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      path: `${prefix}${node.id}`,
      kind: node.kind,
      dependsOn: node.dependsOn ?? [],
      workspace: definition.managedWorktrees ? "<managed-worktree>" : (node.workspace ?? "."),
      priority: node.priority ?? 0,
      maxAttempts: (node.maxRetries ?? 0) + 1,
      ...(node.kind === "map" ? { dynamicItems: node.maxItems ?? 32 } : {}),
      inputBindings: [
        ...Object.values(node.inputs ?? {}).map((binding) => `${binding.nodeId}${binding.pointer ?? ""}`),
        ...(node.source ? [`${node.source.nodeId}${node.source.pointer ?? ""}`] : []),
      ],
      ...(definition.managedWorktrees && graphNodeIsEffectful(node)
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
