import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  engineeringSubgraphStateId,
  graphDefinitionFingerprint,
  parseEngineeringGraphDefinition,
  type EngineeringGraphDefinition,
} from "./graph-contract.js";
import { resolveEngineeringGraphWorkspaces } from "./graph-engineering.js";
import { createEngineeringGraphLogWriter } from "./graph-history.js";
import { archiveEngineeringGraphRun } from "./graph-run-history.js";
import {
  engineeringGraphStateExists,
  loadEngineeringGraphState,
  MAX_GRAPH_EVENTS,
  saveEngineeringGraphState,
  validateEngineeringGraphState,
  type EngineeringGraphState,
  type GraphEvent,
} from "./graph-state.js";
import { orchestrationDescendantClosure } from "./orchestration.js";
import { acquireSessionLease } from "./session-lease.js";

export type EngineeringGraphMigrationPlan = {
  graphId: string;
  graphPolicyChanged: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  preserved: string[];
  invalidated: string[];
};

export type EngineeringGraphMigrationResult = {
  plan: EngineeringGraphMigrationPlan;
  state: EngineeringGraphState;
};

export class EngineeringGraphMigrationConflictError extends Error {
  override name = "EngineeringGraphMigrationConflictError";
}

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

function assertMigrationEligible(before: EngineeringGraphState, after: EngineeringGraphDefinition): void {
  if (before.graphId !== after.graphId) throw new Error("Graph migration requires the same graph id");
  if (before.status === "running" || before.activeAttempts.length > 0) {
    throw new EngineeringGraphMigrationConflictError(
      `Graph must be paused or terminal before migration: ${before.graphId}`,
    );
  }
  if (before.parentGraph) throw new Error("Nested child Graphs must be migrated through their parent Graph");
  if (before.definition.managedWorktrees || after.managedWorktrees) {
    throw new Error("Graph migration does not yet support managed worktrees; archive/prune and restart instead");
  }
}

function migratedPauseReason(results: EngineeringGraphState["results"]): EngineeringGraphState["pauseReason"] {
  if (results.some((result) => result.status === "waiting_approval")) return "approval";
  if (results.some((result) => result.status === "waiting_signal")) return "wait";
  return "control";
}

/**
 * Applies a migration while holding the Graph's authoritative lease. The
 * preflight plan is deliberately recomputed after the checkpoint is reloaded.
 */
export function applyEngineeringGraphMigration(workspace: string, input: unknown): EngineeringGraphMigrationResult {
  const definition = parseEngineeringGraphDefinition(input);
  const preflight = loadEngineeringGraphState(workspace, definition.graphId);
  if (!preflight) {
    const qualifier = engineeringGraphStateExists(workspace, definition.graphId) ? "invalid" : "not found";
    throw new Error(`Persisted Graph ${qualifier}: ${definition.graphId}`);
  }
  assertMigrationEligible(preflight, definition);
  resolveEngineeringGraphWorkspaces(workspace, definition);
  planEngineeringGraphMigration(preflight.definition, definition);

  const lease = acquireSessionLease(workspace, `engineering-graph-${definition.graphId}`);
  try {
    const current = loadEngineeringGraphState(workspace, definition.graphId);
    if (!current) {
      const qualifier = engineeringGraphStateExists(workspace, definition.graphId) ? "invalid" : "not found";
      throw new Error(`Persisted Graph ${qualifier}: ${definition.graphId}`);
    }
    assertMigrationEligible(current, definition);
    const workspaces = resolveEngineeringGraphWorkspaces(workspace, definition);
    const plan = planEngineeringGraphMigration(current.definition, definition);
    const invalidatedExisting = new Set([...plan.invalidated, ...plan.removed]);
    if (
      current.definition.nodes.some(
        (node) => node.kind === "subgraph" && node.graph !== undefined && invalidatedExisting.has(node.id),
      )
    ) {
      throw new Error("Graph migration cannot invalidate an existing subgraph checkpoint; prune/restart instead");
    }
    const assertSubgraphTreeIsNew = (
      ownerId: string,
      node: EngineeringGraphDefinition["nodes"][number],
      path: string,
    ): void => {
      if (node.kind !== "subgraph" || node.graph === undefined) return;
      const childId = engineeringSubgraphStateId(ownerId, node.id, node.graph.graphId);
      const childWorkspace = workspaces.get(path)!;
      if (engineeringGraphStateExists(childWorkspace, childId)) {
        throw new Error(`Graph migration cannot bind added subgraph ${path} to an existing child checkpoint`);
      }
      for (const nested of node.graph.nodes) {
        if (nested.kind === "subgraph") assertSubgraphTreeIsNew(childId, nested, `${path}/${nested.id}`);
      }
    };
    for (const node of definition.nodes) {
      if (plan.added.includes(node.id)) assertSubgraphTreeIsNew(definition.graphId, node, node.id);
    }
    const preserved = new Set(plan.preserved);
    const results = definition.nodes.flatMap((node) => {
      if (!preserved.has(node.id)) return [];
      const result = current.results.find((candidate) => candidate.id === node.id);
      return result ? [result] : [];
    });
    const resultIds = new Set(results.map((result) => result.id));
    const mapProgressEntries = Object.entries(current.mapProgress ?? {}).filter(([nodeId]) => preserved.has(nodeId));
    const mapProgress = Object.fromEntries(mapProgressEntries);
    const unchanged =
      !plan.graphPolicyChanged && plan.added.length === 0 && plan.removed.length === 0 && plan.changed.length === 0;
    const fanIn = unchanged ? current.fanIn : undefined;
    const uncommittedMapItems = mapProgressEntries.flatMap(([nodeId, items]) => (resultIds.has(nodeId) ? [] : items));
    const spentCost =
      results.reduce((sum, result) => sum + result.costUsd, 0) +
      uncommittedMapItems.reduce((sum, item) => sum + item.costUsd, 0) +
      (fanIn?.costUsd ?? 0);
    const spentTokens =
      results.reduce((sum, result) => sum + result.tokensUsed, 0) +
      uncommittedMapItems.reduce((sum, item) => sum + item.tokensUsed, 0) +
      (fanIn?.tokensUsed ?? 0);
    const now = new Date().toISOString();
    const event: GraphEvent = {
      sequence: (current.events.at(-1)?.sequence ?? 0) + 1,
      type: "graph.migrated",
      timestamp: now,
      status: "paused",
      message: `Preserved ${plan.preserved.length}; invalidated ${plan.invalidated.length}; added ${plan.added.length}; removed ${plan.removed.length}`,
    };
    const next = validateEngineeringGraphState({
      schemaVersion: 2,
      graphId: definition.graphId,
      fingerprint: graphDefinitionFingerprint(definition, workspaces),
      status: "paused",
      definition,
      results,
      events: [...current.events, event].slice(-MAX_GRAPH_EVENTS),
      spentCost,
      spentTokens,
      elapsedMs: current.elapsedMs,
      activeAttempts: [],
      mapProgress,
      controlSeq: current.controlSeq,
      controlRunId: `graph-migration-${randomUUID()}`,
      priority: current.priority,
      pauseReason: migratedPauseReason(results),
      createdAt: current.createdAt,
      updatedAt: now,
      resourceGeneration: randomUUID(),
      ...(current.parentGraph ? { parentGraph: current.parentGraph } : {}),
      ...(fanIn ? { fanIn } : {}),
    });
    archiveEngineeringGraphRun(workspace, current);
    saveEngineeringGraphState(workspace, next);
    try {
      const writer = createEngineeringGraphLogWriter(workspace, definition.graphId);
      writer.append(event);
      writer.close();
    } catch {
      // The atomic checkpoint remains authoritative when history I/O fails.
    }
    return { plan, state: next };
  } finally {
    lease.release();
  }
}
