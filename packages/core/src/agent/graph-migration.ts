import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  engineeringSubgraphStateId,
  graphNodeIsEffectful,
  graphDefinitionFingerprint,
  parseEngineeringGraphDefinition,
  type EngineeringGraphDefinition,
} from "./graph-contract.js";
import { resolveEngineeringGraphWorkspaces } from "./graph-engineering.js";
import { createEngineeringGraphLogWriter, readEngineeringGraphHistory } from "./graph-history.js";
import { archiveEngineeringGraphRun } from "./graph-run-history.js";
import {
  engineeringGraphStateExists,
  listEngineeringGraphStates,
  loadEngineeringGraphState,
  MAX_GRAPH_EVENTS,
  MAX_GRAPH_STATE_BYTES,
  saveEngineeringGraphState,
  validateEngineeringGraphState,
  type EngineeringGraphState,
  type GraphEvent,
} from "./graph-state.js";
import { isDenseArray, orchestrationDescendantClosure } from "./orchestration.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";
import { managedOrchestrationWorktreePath } from "./orchestration-worktrees.js";

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
export type EngineeringGraphTreeMigrationEntry = {
  path: string;
  runtimeGraphId: string;
  stateStatus: "available" | "missing";
  plan: EngineeringGraphMigrationPlan;
};
export type EngineeringGraphTreeMigrationPlan = {
  graphId: string;
  mode: "no_op" | "single_checkpoint" | "coordinated_tree";
  entries: EngineeringGraphTreeMigrationEntry[];
  blockers: string[];
};
export type EngineeringGraphMigrationOptions = {
  /** Test/eval-only crash boundary hook; production callers should omit it. */
  faultInjector?: (point: "after_journal_prepared" | "after_checkpoint_committed" | "after_journal_committed") => void;
};

export type EngineeringGraphTreeCheckpoint = {
  workspace: string;
  state: EngineeringGraphState;
};

/** Loads root and nested checkpoints with their resolved physical workspace owners. */
export function listEngineeringGraphTreeCheckpoints(
  workspace: string,
  definitionInputs: readonly unknown[],
): EngineeringGraphTreeCheckpoint[] {
  if (!isDenseArray(definitionInputs) || definitionInputs.length === 0 || definitionInputs.length > 2) {
    throw new Error("Graph tree state discovery requires one or two dense definitions");
  }
  const checkpoints = new Map<string, EngineeringGraphTreeCheckpoint>();
  const visit = (baseWorkspace: string, definition: EngineeringGraphDefinition, runtimeGraphId: string): void => {
    const physicalWorkspace = realpathSync.native(baseWorkspace);
    const state = loadEngineeringGraphState(physicalWorkspace, runtimeGraphId);
    if (state) {
      const existing = checkpoints.get(runtimeGraphId);
      if (existing && (existing.workspace !== physicalWorkspace || !isDeepStrictEqual(existing.state, state))) {
        throw new Error(`Graph tree contains conflicting checkpoint identities: ${runtimeGraphId}`);
      }
      checkpoints.set(runtimeGraphId, { workspace: physicalWorkspace, state });
    }
    const runtimeDefinition = { ...definition, graphId: runtimeGraphId };
    const workspaces = resolveEngineeringGraphWorkspaces(physicalWorkspace, runtimeDefinition);
    for (const node of definition.nodes) {
      if (node.kind !== "subgraph" || node.graph === undefined) continue;
      const childId = engineeringSubgraphStateId(runtimeGraphId, node.id, node.graph.graphId);
      visit(workspaces.get(node.id)!, node.graph, childId);
    }
  };
  for (const input of definitionInputs) {
    const definition = parseEngineeringGraphDefinition(input);
    visit(workspace, definition, definition.graphId);
  }
  return [...checkpoints.values()].sort((left, right) => left.state.graphId.localeCompare(right.state.graphId));
}

/** Loads root and nested states without discarding their physical ownership during discovery. */
export function listEngineeringGraphTreeStates(
  workspace: string,
  definitionInputs: readonly unknown[],
): EngineeringGraphState[] {
  return listEngineeringGraphTreeCheckpoints(workspace, definitionInputs).map((checkpoint) => checkpoint.state);
}

/** Discovers direct checkpoints plus reachable child checkpoints and their physical owners. */
export function listWorkspaceEngineeringGraphTreeCheckpoints(workspace: string): EngineeringGraphTreeCheckpoint[] {
  const physicalWorkspace = realpathSync.native(workspace);
  const direct = listEngineeringGraphStates(workspace, { requireComplete: true });
  const checkpoints = new Map(direct.map((state) => [state.graphId, { workspace: physicalWorkspace, state }]));
  for (const root of direct.filter((state) => state.parentGraph === undefined)) {
    for (const checkpoint of listEngineeringGraphTreeCheckpoints(workspace, [root.definition])) {
      const existing = checkpoints.get(checkpoint.state.graphId);
      if (
        existing &&
        (existing.workspace !== checkpoint.workspace || !isDeepStrictEqual(existing.state, checkpoint.state))
      ) {
        throw new Error(`Workspace contains conflicting Graph checkpoint identities: ${checkpoint.state.graphId}`);
      }
      checkpoints.set(checkpoint.state.graphId, checkpoint);
      if (checkpoints.size > 512) throw new Error("Workspace Graph tree exceeds the complete portfolio scan limit");
    }
  }
  return [...checkpoints.values()].sort(
    (left, right) => Date.parse(right.state.updatedAt) - Date.parse(left.state.updatedAt),
  );
}

/** Discovers direct and reachable child states for consumers that do not perform workspace I/O. */
export function listWorkspaceEngineeringGraphTreeStates(workspace: string): EngineeringGraphState[] {
  return listWorkspaceEngineeringGraphTreeCheckpoints(workspace).map((checkpoint) => checkpoint.state);
}

export type EngineeringGraphMigrationJournal = {
  version: 1;
  graphId: string;
  sourceFingerprint: string;
  targetFingerprint: string;
  resourceGeneration: string;
  phase: "prepared" | "committed";
  preparedAt: string;
  committedAt?: string;
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

/** Requires an append-only change so a paused checkpoint can evolve without invalidating completed work. */
export function planEngineeringGraphExpansion(
  beforeInput: unknown,
  afterInput: unknown,
): EngineeringGraphMigrationPlan {
  const before = parseEngineeringGraphDefinition(beforeInput);
  const after = parseEngineeringGraphDefinition(afterInput);
  const plan = planEngineeringGraphMigration(before, after);
  const assertAppendOnly = (prior: EngineeringGraphDefinition, target: EngineeringGraphDefinition): void => {
    if (prior.graphId !== target.graphId) throw new Error("Dynamic Graph expansion cannot change a nested graph id");
    const { nodes: _priorNodes, ...priorPolicy } = prior;
    const { nodes: _targetNodes, ...targetPolicy } = target;
    if (!isDeepStrictEqual(priorPolicy, targetPolicy)) {
      throw new Error("Dynamic Graph expansion cannot change Graph policy");
    }
    const targetNodes = new Map(target.nodes.map((node) => [node.id, node]));
    for (const oldNode of prior.nodes) {
      const newNode = targetNodes.get(oldNode.id);
      if (!newNode) throw new Error(`Dynamic Graph expansion cannot remove node ${oldNode.id}`);
      const { graph: oldGraph, ...oldNodeContract } = oldNode;
      const { graph: newGraph, ...newNodeContract } = newNode;
      if (!isDeepStrictEqual(oldNodeContract, newNodeContract)) {
        throw new Error(`Dynamic Graph expansion cannot change existing node ${oldNode.id}`);
      }
      if ((oldGraph === undefined) !== (newGraph === undefined)) {
        throw new Error(`Dynamic Graph expansion cannot change existing node ${oldNode.id}`);
      }
      if (oldGraph && newGraph) assertAppendOnly(oldGraph, newGraph);
    }
  };
  assertAppendOnly(before, after);
  return plan;
}

/** Resolves every retained child identity before any checkpoint is mutated. */
export function planEngineeringGraphTreeMigration(
  beforeInput: unknown,
  afterInput: unknown,
  states: readonly EngineeringGraphState[] = [],
): EngineeringGraphTreeMigrationPlan {
  const before = parseEngineeringGraphDefinition(beforeInput);
  const after = parseEngineeringGraphDefinition(afterInput);
  if (before.graphId !== after.graphId) throw new Error("Graph tree migration requires the same root graph id");
  const byId = new Map(states.map((state) => [state.graphId, state]));
  if (byId.size !== states.length) throw new Error("Graph tree migration states contain duplicate graph ids");
  const entries: EngineeringGraphTreeMigrationEntry[] = [];
  const blockers: string[] = [];
  let detachedCheckpoint = false;
  const visit = (
    prior: EngineeringGraphDefinition,
    target: EngineeringGraphDefinition,
    runtimeGraphId: string,
    path: string,
    expectedParent?: { graphId: string; nodeId: string },
  ): void => {
    const plan = planEngineeringGraphMigration(
      { ...prior, graphId: runtimeGraphId },
      { ...target, graphId: runtimeGraphId },
    );
    const state = byId.get(runtimeGraphId);
    entries.push({ path, runtimeGraphId, stateStatus: state ? "available" : "missing", plan });
    if (state && (state.status === "running" || state.activeAttempts.length > 0)) {
      blockers.push(`Graph ${path} is running`);
    }
    if (
      state &&
      (!isDeepStrictEqual(state.definition, { ...prior, graphId: runtimeGraphId }) ||
        !isDeepStrictEqual(state.parentGraph, expectedParent))
    ) {
      blockers.push(`Graph ${path} checkpoint does not match its source definition or parent provenance`);
    }
    const targetNodes = new Map(target.nodes.map((node) => [node.id, node]));
    const priorNodes = new Map(prior.nodes.map((node) => [node.id, node]));
    for (const oldNode of prior.nodes) {
      const newNode = targetNodes.get(oldNode.id);
      if (oldNode.kind === "subgraph" && oldNode.graph !== undefined) {
        const oldChildId = engineeringSubgraphStateId(runtimeGraphId, oldNode.id, oldNode.graph.graphId);
        if (
          (newNode?.kind !== "subgraph" ||
            newNode.graph === undefined ||
            oldNode.graph.graphId !== newNode.graph.graphId) &&
          byId.has(oldChildId)
        ) {
          detachedCheckpoint = true;
          blockers.push(`Graph ${path}/${oldNode.id} retains a child checkpoint that the target removes or replaces`);
        }
      }
      if (
        oldNode.kind !== "subgraph" ||
        newNode?.kind !== "subgraph" ||
        oldNode.graph === undefined ||
        newNode.graph === undefined ||
        oldNode.graph.graphId !== newNode.graph.graphId
      ) {
        continue;
      }
      const childId = engineeringSubgraphStateId(runtimeGraphId, oldNode.id, oldNode.graph.graphId);
      visit(oldNode.graph, newNode.graph, childId, `${path}/${oldNode.id}`, {
        graphId: runtimeGraphId,
        nodeId: oldNode.id,
      });
    }
    for (const newNode of target.nodes) {
      const oldNode = priorNodes.get(newNode.id);
      if (newNode.kind !== "subgraph" || newNode.graph === undefined) continue;
      if (oldNode?.kind === "subgraph" && oldNode.graph?.graphId === newNode.graph.graphId) continue;
      const newChildId = engineeringSubgraphStateId(runtimeGraphId, newNode.id, newNode.graph.graphId);
      if (byId.has(newChildId)) {
        detachedCheckpoint = true;
        blockers.push(`Graph ${path}/${newNode.id} would bind an unrelated existing child checkpoint`);
      }
    }
  };
  visit(before, after, before.graphId, before.graphId);
  const changedEntries = entries.filter(
    (entry) =>
      entry.plan.graphPolicyChanged ||
      entry.plan.added.length > 0 ||
      entry.plan.removed.length > 0 ||
      entry.plan.changed.length > 0,
  );
  const requiresTreeTransaction =
    detachedCheckpoint || changedEntries.length > 1 || changedEntries.some((entry) => entry.path !== before.graphId);
  return {
    graphId: before.graphId,
    mode: changedEntries.length === 0 ? "no_op" : requiresTreeTransaction ? "coordinated_tree" : "single_checkpoint",
    entries,
    blockers,
  };
}

function assertMigrationEligible(before: EngineeringGraphState, after: EngineeringGraphDefinition): void {
  if (before.graphId !== after.graphId) throw new Error("Graph migration requires the same graph id");
  if (before.status === "running" || before.activeAttempts.length > 0) {
    throw new EngineeringGraphMigrationConflictError(
      `Graph must be paused or terminal before migration: ${before.graphId}`,
    );
  }
  if (before.parentGraph) throw new Error("Nested child Graphs must be migrated through their parent Graph");
  if (!isDeepStrictEqual(before.definition.managedWorktrees, after.managedWorktrees)) {
    throw new Error("Graph migration cannot change managed worktrees policy; archive/prune and restart instead");
  }
  if (before.definition.managedWorktrees) {
    const managedIds = (definition: EngineeringGraphDefinition): string[] =>
      [
        ...definition.nodes.filter(graphNodeIsEffectful).map((node) => node.id),
        ...(definition.fanIn ? ["__fan_in__"] : []),
      ].sort();
    if (!isDeepStrictEqual(managedIds(before.definition), managedIds(after))) {
      throw new Error("Graph migration cannot change managed worktrees topology; archive/prune and restart instead");
    }
  }
}

function migrationJournalPath(graphId: string): string {
  return `.seekforge/graphs/${graphId}.migration.json`;
}

export function readEngineeringGraphMigrationJournal(
  workspace: string,
  graphId: string,
): EngineeringGraphMigrationJournal | undefined {
  try {
    const raw = readWorkspaceStateFile(workspace, migrationJournalPath(graphId), 16 * 1024);
    if (raw === undefined) return undefined;
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, [
        "version",
        "graphId",
        "sourceFingerprint",
        "targetFingerprint",
        "resourceGeneration",
        "phase",
        "preparedAt",
        "committedAt",
      ]) ||
      value.version !== 1 ||
      value.graphId !== graphId ||
      typeof value.sourceFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sourceFingerprint) ||
      typeof value.targetFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.targetFingerprint) ||
      typeof value.resourceGeneration !== "string" ||
      (value.phase !== "prepared" && value.phase !== "committed") ||
      typeof value.preparedAt !== "string" ||
      !Number.isFinite(Date.parse(value.preparedAt)) ||
      (value.phase === "prepared" && value.committedAt !== undefined) ||
      (value.phase === "committed" &&
        (typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt))))
    )
      return undefined;
    return value as EngineeringGraphMigrationJournal;
  } catch {
    return undefined;
  }
}

function migrationWorkspaces(workspace: string, definition: EngineeringGraphDefinition): Map<string, string> {
  if (!definition.managedWorktrees) return resolveEngineeringGraphWorkspaces(workspace, definition);
  const overrides = new Map(
    definition.nodes
      .filter(graphNodeIsEffectful)
      .map((node) => [node.id, managedOrchestrationWorktreePath(workspace, "graph", definition.graphId, node.id)]),
  );
  return resolveEngineeringGraphWorkspaces(workspace, definition, overrides);
}

function migratedPauseReason(results: EngineeringGraphState["results"]): EngineeringGraphState["pauseReason"] {
  if (results.some((result) => result.status === "waiting_approval")) return "approval";
  if (results.some((result) => result.status === "waiting_signal")) return "wait";
  return "control";
}

function migrationJournalTargetsState(
  journal: EngineeringGraphMigrationJournal,
  state: EngineeringGraphState,
): boolean {
  return journal.targetFingerprint === state.fingerprint && journal.resourceGeneration === state.resourceGeneration;
}

function repairEngineeringGraphHistory(workspace: string, state: EngineeringGraphState): void {
  try {
    const retained = readEngineeringGraphHistory(workspace, state.graphId, { limit: 2_000, tail: true });
    const latestSequence = retained.at(-1)?.event.sequence ?? 0;
    const missing = state.events.filter((event) => event.sequence > latestSequence);
    if (missing.length === 0) return;
    const writer = createEngineeringGraphLogWriter(workspace, state.graphId);
    try {
      for (const event of missing) writer.append(event);
    } finally {
      writer.close();
    }
  } catch {
    // The checkpoint remains authoritative when best-effort history repair fails.
  }
}

function finishCommittedMigration(
  workspace: string,
  state: EngineeringGraphState,
  journal: EngineeringGraphMigrationJournal,
): void {
  if (!migrationJournalTargetsState(journal, state)) return;
  repairEngineeringGraphHistory(workspace, state);
  if (journal.phase === "prepared") {
    writeWorkspaceStateFileAtomic(
      workspace,
      migrationJournalPath(state.graphId),
      `${JSON.stringify({ ...journal, phase: "committed", committedAt: new Date().toISOString() })}\n`,
    );
  }
}

/**
 * Applies a migration while holding the Graph's authoritative lease. The
 * preflight plan is deliberately recomputed after the checkpoint is reloaded.
 */
export function applyEngineeringGraphMigration(
  workspace: string,
  input: unknown,
  options: EngineeringGraphMigrationOptions = {},
): EngineeringGraphMigrationResult {
  const definition = parseEngineeringGraphDefinition(input);
  const preflight = loadEngineeringGraphState(workspace, definition.graphId);
  if (!preflight) {
    const qualifier = engineeringGraphStateExists(workspace, definition.graphId) ? "invalid" : "not found";
    throw new Error(`Persisted Graph ${qualifier}: ${definition.graphId}`);
  }
  assertMigrationEligible(preflight, definition);
  migrationWorkspaces(workspace, definition);
  planEngineeringGraphMigration(preflight.definition, definition);

  const lease = acquireSessionLease(workspace, `engineering-graph-${definition.graphId}`);
  try {
    const current = loadEngineeringGraphState(workspace, definition.graphId);
    if (!current) {
      const qualifier = engineeringGraphStateExists(workspace, definition.graphId) ? "invalid" : "not found";
      throw new Error(`Persisted Graph ${qualifier}: ${definition.graphId}`);
    }
    assertMigrationEligible(current, definition);
    const workspaces = migrationWorkspaces(workspace, definition);
    const plan = planEngineeringGraphMigration(current.definition, definition);
    const existingJournal = readEngineeringGraphMigrationJournal(workspace, definition.graphId);
    if (existingJournal) finishCommittedMigration(workspace, current, existingJournal);
    if (
      existingJournal?.phase === "prepared" &&
      existingJournal.sourceFingerprint !== current.fingerprint &&
      !migrationJournalTargetsState(existingJournal, current)
    ) {
      throw new EngineeringGraphMigrationConflictError("Graph has an unresolved migration journal");
    }
    if (!plan.graphPolicyChanged && plan.added.length === 0 && plan.removed.length === 0 && plan.changed.length === 0) {
      return { plan, state: current };
    }
    if (current.definition.managedWorktrees) {
      const invalidated = new Set([...plan.invalidated, ...plan.removed]);
      if (current.definition.nodes.some((node) => graphNodeIsEffectful(node) && invalidated.has(node.id))) {
        throw new Error("Graph migration cannot invalidate a managed worktree node; promote/prune and restart instead");
      }
    }
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
    const journal: EngineeringGraphMigrationJournal = {
      version: 1,
      graphId: definition.graphId,
      sourceFingerprint: current.fingerprint,
      targetFingerprint: next.fingerprint,
      resourceGeneration: next.resourceGeneration!,
      phase: "prepared",
      preparedAt: now,
    };
    writeWorkspaceStateFileAtomic(workspace, migrationJournalPath(definition.graphId), `${JSON.stringify(journal)}\n`);
    options.faultInjector?.("after_journal_prepared");
    // Snapshot archival is idempotent by fingerprint/completedAt. Doing it
    // before replacement avoids losing the source run if the process exits in
    // the checkpoint-to-journal window; a retry safely observes the snapshot.
    archiveEngineeringGraphRun(workspace, current);
    saveEngineeringGraphState(workspace, next);
    options.faultInjector?.("after_checkpoint_committed");
    writeWorkspaceStateFileAtomic(
      workspace,
      migrationJournalPath(definition.graphId),
      `${JSON.stringify({ ...journal, phase: "committed", committedAt: new Date().toISOString() })}\n`,
    );
    options.faultInjector?.("after_journal_committed");
    repairEngineeringGraphHistory(workspace, next);
    return { plan, state: next };
  } finally {
    lease.release();
  }
}

export type EngineeringGraphTreeMigrationJournalParticipant = {
  workspace: string;
  graphId: string;
  path: string;
  sourceFingerprint: string;
  sourceStateHash: string;
  targetFingerprint: string;
  targetStateHash: string;
};

export type EngineeringGraphTreeMigrationJournal = {
  version: 1;
  transactionId: string;
  graphId: string;
  phase: "preparing" | "prepared" | "committed";
  preparedAt: string;
  committedAt?: string;
  participants: EngineeringGraphTreeMigrationJournalParticipant[];
};

export type EngineeringGraphTreeMigrationOptions = {
  /** Test/eval-only crash boundary hook; production callers should omit it. */
  faultInjector?: (
    point: "after_tree_preparing" | "after_tree_prepared" | "after_child_committed" | "after_root_committed",
  ) => void;
};

export type EngineeringGraphTreeMigrationResult = {
  plan: EngineeringGraphTreeMigrationPlan;
  state: EngineeringGraphState;
  transactionId?: string;
};

type TreeTarget = {
  workspace: string;
  path: string;
  state: EngineeringGraphState;
  definition: EngineeringGraphDefinition;
};

const TREE_TRANSACTION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TREE_STATE_HASH_RE = /^[a-f0-9]{64}$/;
const MAX_TREE_PARTICIPANTS = 128;
const MAX_TREE_JOURNAL_BYTES = 128 * 1024;

function engineeringGraphStateHash(state: EngineeringGraphState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

function treeJournalPath(graphId: string): string {
  return `.seekforge/graphs/${graphId}.tree-migration.json`;
}

function treePreparedPath(graphId: string, transactionId: string): string {
  return `.seekforge/graphs/${graphId}.tree-${transactionId}.prepared.json`;
}

function acquireTreeLeases(targets: readonly { workspace: string; graphId: string }[]): SessionLease[] {
  const leases: SessionLease[] = [];
  try {
    for (const target of targets) {
      leases.push(acquireSessionLease(target.workspace, `engineering-graph-${target.graphId}`));
    }
    return leases;
  } catch (error) {
    for (const lease of leases.reverse()) lease.release();
    throw error;
  }
}

function removePreparedTreeFile(path: string): void {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || realpathSync.native(path) !== path) return;
    unlinkSync(path);
  } catch {
    // A committed transaction can recover without relying on cleanup success.
  }
}

function safeWorkspaceRelative(root: string, workspace: string): string {
  const relativePath = relative(root, workspace);
  if (relativePath === "") return ".";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath.split(sep).includes("..")) {
    throw new Error("Graph tree migration workspace escapes the root workspace");
  }
  return relativePath.split(sep).join("/");
}

function resolveJournalWorkspace(root: string, workspace: string): string {
  if (
    workspace !== "." &&
    (workspace.length === 0 ||
      workspace.startsWith("/") ||
      workspace.split(/[\\/]/).some((part) => !part || part === "." || part === ".."))
  ) {
    throw new Error("Graph tree migration journal workspace is invalid");
  }
  const target = workspace === "." ? root : resolve(root, workspace);
  const physical = realpathSync.native(target);
  if (physical !== root && !physical.startsWith(`${root}${sep}`)) {
    throw new Error("Graph tree migration journal workspace escapes the root workspace");
  }
  return physical;
}

function parseTreeJournal(workspace: string, graphId: string, raw: string): EngineeringGraphTreeMigrationJournal {
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "transactionId",
      "graphId",
      "phase",
      "preparedAt",
      "committedAt",
      "participants",
    ]) ||
    value.version !== 1 ||
    typeof value.transactionId !== "string" ||
    !TREE_TRANSACTION_RE.test(value.transactionId) ||
    value.graphId !== graphId ||
    (value.phase !== "preparing" && value.phase !== "prepared" && value.phase !== "committed") ||
    typeof value.preparedAt !== "string" ||
    !Number.isFinite(Date.parse(value.preparedAt)) ||
    (value.phase !== "committed" && value.committedAt !== undefined) ||
    (value.phase === "committed" &&
      (typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt)))) ||
    !isDenseArray(value.participants) ||
    value.participants.length === 0 ||
    value.participants.length > MAX_TREE_PARTICIPANTS
  ) {
    throw new Error("Persisted Graph tree migration journal is invalid");
  }
  const root = realpathSync.native(workspace);
  const participants: EngineeringGraphTreeMigrationJournalParticipant[] = [];
  for (const participant of value.participants) {
    if (
      !isRecord(participant) ||
      !hasOnlyKeys(participant, [
        "workspace",
        "graphId",
        "path",
        "sourceFingerprint",
        "sourceStateHash",
        "targetFingerprint",
        "targetStateHash",
      ]) ||
      typeof participant.workspace !== "string" ||
      typeof participant.graphId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(participant.graphId) ||
      typeof participant.path !== "string" ||
      participant.path.length === 0 ||
      participant.path.length > 1_024 ||
      typeof participant.sourceFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(participant.sourceFingerprint) ||
      typeof participant.sourceStateHash !== "string" ||
      !TREE_STATE_HASH_RE.test(participant.sourceStateHash) ||
      typeof participant.targetFingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(participant.targetFingerprint) ||
      typeof participant.targetStateHash !== "string" ||
      !TREE_STATE_HASH_RE.test(participant.targetStateHash) ||
      participant.sourceStateHash === participant.targetStateHash
    ) {
      throw new Error("Persisted Graph tree migration participant is invalid");
    }
    const physical = resolveJournalWorkspace(root, participant.workspace);
    if (safeWorkspaceRelative(root, physical) !== participant.workspace) {
      throw new Error("Persisted Graph tree migration participant workspace is not canonical");
    }
    participants.push(participant as EngineeringGraphTreeMigrationJournalParticipant);
  }
  if (
    (value.phase === "committed" && Date.parse(value.committedAt as string) < Date.parse(value.preparedAt as string)) ||
    new Set(
      participants.map(
        (participant) => `${resolveJournalWorkspace(root, participant.workspace)}\0${participant.graphId}`,
      ),
    ).size !== participants.length ||
    participants.at(-1)?.graphId !== graphId ||
    participants.at(-1)?.workspace !== "." ||
    participants.at(-1)?.path !== graphId
  ) {
    throw new Error("Persisted Graph tree migration participants are invalid");
  }
  return { ...(value as EngineeringGraphTreeMigrationJournal), participants };
}

export function readEngineeringGraphTreeMigrationJournal(
  workspace: string,
  graphId: string,
): EngineeringGraphTreeMigrationJournal | undefined {
  const raw = readWorkspaceStateFile(workspace, treeJournalPath(graphId), MAX_TREE_JOURNAL_BYTES);
  return raw === undefined ? undefined : parseTreeJournal(workspace, graphId, raw);
}

function buildTreeMigrationState(
  workspace: string,
  current: EngineeringGraphState,
  definition: EngineeringGraphDefinition,
): { state: EngineeringGraphState; plan: EngineeringGraphMigrationPlan; event?: GraphEvent } {
  if (current.status === "running" || current.activeAttempts.length > 0) {
    throw new EngineeringGraphMigrationConflictError(
      `Graph must be paused or terminal before migration: ${current.graphId}`,
    );
  }
  if (!isDeepStrictEqual(current.definition.managedWorktrees, definition.managedWorktrees)) {
    throw new Error("Graph tree migration cannot change managed worktrees policy");
  }
  const workspaces = migrationWorkspaces(workspace, definition);
  const plan = planEngineeringGraphMigration(current.definition, definition);
  if (!plan.graphPolicyChanged && plan.added.length === 0 && plan.removed.length === 0 && plan.changed.length === 0) {
    return { state: current, plan };
  }
  if (current.definition.managedWorktrees) {
    const invalidated = new Set([...plan.invalidated, ...plan.removed]);
    if (current.definition.nodes.some((node) => graphNodeIsEffectful(node) && invalidated.has(node.id))) {
      throw new Error("Graph tree migration cannot invalidate a managed worktree node");
    }
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
  const uncommittedMapItems = mapProgressEntries.flatMap(([nodeId, items]) => (resultIds.has(nodeId) ? [] : items));
  const spentCost =
    results.reduce((sum, result) => sum + result.costUsd, 0) +
    uncommittedMapItems.reduce((sum, item) => sum + item.costUsd, 0);
  const spentTokens =
    results.reduce((sum, result) => sum + result.tokensUsed, 0) +
    uncommittedMapItems.reduce((sum, item) => sum + item.tokensUsed, 0);
  const now = new Date().toISOString();
  const event: GraphEvent = {
    sequence: (current.events.at(-1)?.sequence ?? 0) + 1,
    type: "graph.migrated",
    timestamp: now,
    status: "paused",
    message: `Tree transaction preserved ${plan.preserved.length}; invalidated ${plan.invalidated.length}; added ${plan.added.length}; removed ${plan.removed.length}`,
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
    controlRunId: `graph-tree-migration-${randomUUID()}`,
    priority: current.priority,
    pauseReason: migratedPauseReason(results),
    createdAt: current.createdAt,
    updatedAt: now,
    resourceGeneration: randomUUID(),
    ...(current.parentGraph ? { parentGraph: current.parentGraph } : {}),
  });
  return { state: next, plan, event };
}

function collectTreeTargets(
  workspace: string,
  before: EngineeringGraphDefinition,
  after: EngineeringGraphDefinition,
): TreeTarget[] {
  const targets: TreeTarget[] = [];
  const visit = (
    baseWorkspace: string,
    prior: EngineeringGraphDefinition,
    target: EngineeringGraphDefinition,
    runtimeGraphId: string,
    path: string,
  ): void => {
    const physical = realpathSync.native(baseWorkspace);
    const state = loadEngineeringGraphState(physical, runtimeGraphId);
    if (state) targets.push({ workspace: physical, path, state, definition: { ...target, graphId: runtimeGraphId } });
    const priorRuntime = { ...prior, graphId: runtimeGraphId };
    const targetRuntime = { ...target, graphId: runtimeGraphId };
    const priorWorkspaces = migrationWorkspaces(physical, priorRuntime);
    const targetWorkspaces = migrationWorkspaces(physical, targetRuntime);
    const oldNodes = new Map(prior.nodes.map((node) => [node.id, node]));
    for (const newNode of target.nodes) {
      const oldNode = oldNodes.get(newNode.id);
      if (
        oldNode?.kind !== "subgraph" ||
        newNode.kind !== "subgraph" ||
        oldNode.graph === undefined ||
        newNode.graph === undefined ||
        oldNode.graph.graphId !== newNode.graph.graphId
      ) {
        continue;
      }
      const sourceWorkspace = realpathSync.native(priorWorkspaces.get(oldNode.id)!);
      const destinationWorkspace = realpathSync.native(targetWorkspaces.get(newNode.id)!);
      const childId = engineeringSubgraphStateId(runtimeGraphId, oldNode.id, oldNode.graph.graphId);
      if (sourceWorkspace !== destinationWorkspace && engineeringGraphStateExists(sourceWorkspace, childId)) {
        throw new Error(`Graph tree migration cannot relocate checkpoint ${path}/${oldNode.id}`);
      }
      visit(sourceWorkspace, oldNode.graph, newNode.graph, childId, `${path}/${oldNode.id}`);
    }
  };
  visit(workspace, before, after, before.graphId, before.graphId);
  return targets;
}

function loadPreparedTreeState(
  workspace: string,
  participant: EngineeringGraphTreeMigrationJournalParticipant,
  transactionId: string,
): EngineeringGraphState {
  const raw = readWorkspaceStateFile(
    workspace,
    treePreparedPath(participant.graphId, transactionId),
    MAX_GRAPH_STATE_BYTES,
  );
  if (raw === undefined) throw new Error(`Prepared Graph tree checkpoint is missing: ${participant.path}`);
  const parsed = validateEngineeringGraphState(JSON.parse(raw) as EngineeringGraphState);
  if (
    parsed.graphId !== participant.graphId ||
    parsed.fingerprint !== participant.targetFingerprint ||
    engineeringGraphStateHash(parsed) !== participant.targetStateHash
  ) {
    throw new Error(`Prepared Graph tree checkpoint does not match its journal: ${participant.path}`);
  }
  return parsed;
}

function commitTreeJournal(
  workspace: string,
  journal: EngineeringGraphTreeMigrationJournal,
  faultInjector?: EngineeringGraphTreeMigrationOptions["faultInjector"],
): EngineeringGraphState {
  if (journal.phase !== "prepared") throw new Error("Graph tree migration journal is not prepared");
  const root = realpathSync.native(workspace);
  let rootState: EngineeringGraphState | undefined;
  for (const [index, participant] of journal.participants.entries()) {
    const participantWorkspace = resolveJournalWorkspace(root, participant.workspace);
    const current = loadEngineeringGraphState(participantWorkspace, participant.graphId);
    if (!current) throw new Error(`Graph tree migration checkpoint is missing: ${participant.path}`);
    const currentStateHash = engineeringGraphStateHash(current);
    if (current.fingerprint === participant.targetFingerprint && currentStateHash === participant.targetStateHash) {
      repairEngineeringGraphHistory(participantWorkspace, current);
      if (index === journal.participants.length - 1) rootState = current;
      continue;
    }
    if (current.fingerprint !== participant.sourceFingerprint || currentStateHash !== participant.sourceStateHash) {
      throw new EngineeringGraphMigrationConflictError(`Graph tree migration checkpoint changed: ${participant.path}`);
    }
    const prepared = loadPreparedTreeState(participantWorkspace, participant, journal.transactionId);
    archiveEngineeringGraphRun(participantWorkspace, current);
    saveEngineeringGraphState(participantWorkspace, prepared);
    if (index === journal.participants.length - 1) {
      rootState = prepared;
      faultInjector?.("after_root_committed");
    } else faultInjector?.("after_child_committed");
    repairEngineeringGraphHistory(participantWorkspace, prepared);
  }
  if (!rootState) throw new Error("Graph tree migration did not commit its root checkpoint");
  const committed: EngineeringGraphTreeMigrationJournal = {
    ...journal,
    phase: "committed",
    committedAt: new Date().toISOString(),
  };
  writeWorkspaceStateFileAtomic(workspace, treeJournalPath(journal.graphId), `${JSON.stringify(committed)}\n`);
  for (const participant of journal.participants) {
    const participantWorkspace = resolveJournalWorkspace(root, participant.workspace);
    const prepared = resolve(participantWorkspace, treePreparedPath(participant.graphId, journal.transactionId));
    removePreparedTreeFile(prepared);
  }
  return rootState;
}

/** Finishes a prepared tree transaction by rolling every participant forward, with the root committed last. */
export function recoverEngineeringGraphTreeMigration(
  workspace: string,
  graphId: string,
  options: EngineeringGraphTreeMigrationOptions = {},
): EngineeringGraphState | undefined {
  const journal = readEngineeringGraphTreeMigrationJournal(workspace, graphId);
  if (!journal) return undefined;
  const root = realpathSync.native(workspace);
  if (journal.phase === "committed") {
    for (const participant of journal.participants) {
      const participantWorkspace = resolveJournalWorkspace(root, participant.workspace);
      removePreparedTreeFile(
        resolve(participantWorkspace, treePreparedPath(participant.graphId, journal.transactionId)),
      );
    }
    return loadEngineeringGraphState(workspace, graphId) ?? undefined;
  }
  const leaseTargets = journal.participants
    .map((participant) => ({
      key: `${participant.workspace}\0${participant.graphId}`,
      workspace: resolveJournalWorkspace(root, participant.workspace),
      graphId: participant.graphId,
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const leases = acquireTreeLeases(leaseTargets);
  try {
    const currentJournal = readEngineeringGraphTreeMigrationJournal(workspace, graphId);
    if (!currentJournal || !isDeepStrictEqual(currentJournal, journal)) {
      throw new EngineeringGraphMigrationConflictError("Graph tree migration journal changed during recovery");
    }
    if (journal.phase === "preparing") {
      for (const participant of journal.participants) {
        const participantWorkspace = resolveJournalWorkspace(root, participant.workspace);
        removePreparedTreeFile(
          resolve(participantWorkspace, treePreparedPath(participant.graphId, journal.transactionId)),
        );
      }
      removePreparedTreeFile(resolve(root, treeJournalPath(journal.graphId)));
      return loadEngineeringGraphState(workspace, graphId) ?? undefined;
    }
    return commitTreeJournal(workspace, journal, options.faultInjector);
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
}

/** Applies a root and its retained child checkpoints as one recoverable tree transaction. */
export function applyEngineeringGraphTreeMigration(
  workspace: string,
  input: unknown,
  options: EngineeringGraphTreeMigrationOptions = {},
): EngineeringGraphTreeMigrationResult {
  const definition = parseEngineeringGraphDefinition(input);
  const recovered = recoverEngineeringGraphTreeMigration(workspace, definition.graphId);
  const currentRoot = recovered ?? loadEngineeringGraphState(workspace, definition.graphId);
  if (!currentRoot) throw new Error(`Persisted Graph not found or invalid: ${definition.graphId}`);
  if (isDeepStrictEqual(currentRoot.definition, definition)) {
    const states = listEngineeringGraphTreeStates(workspace, [definition]);
    return {
      plan: planEngineeringGraphTreeMigration(currentRoot.definition, definition, states),
      state: currentRoot,
    };
  }
  const discovered = listEngineeringGraphTreeStates(workspace, [currentRoot.definition, definition]);
  const plan = planEngineeringGraphTreeMigration(currentRoot.definition, definition, discovered);
  if (plan.blockers.length > 0) throw new EngineeringGraphMigrationConflictError(plan.blockers.join("; "));
  const targets = collectTreeTargets(workspace, currentRoot.definition, definition);
  const changedTargets = targets.filter((target) => {
    const migration = planEngineeringGraphMigration(target.state.definition, target.definition);
    return (
      migration.graphPolicyChanged ||
      migration.added.length > 0 ||
      migration.removed.length > 0 ||
      migration.changed.length > 0
    );
  });
  if (changedTargets.length === 0) return { plan, state: currentRoot };
  const ordered = [...changedTargets].sort(
    (left, right) => right.path.split("/").length - left.path.split("/").length || left.path.localeCompare(right.path),
  );
  if (ordered.length > MAX_TREE_PARTICIPANTS || ordered.some((target) => target.path.length > 1_024)) {
    throw new Error("Graph tree migration exceeds the bounded transaction participant limit");
  }
  const root = realpathSync.native(workspace);
  const leaseTargets = [...ordered]
    .map((target) => ({ ...target, key: `${safeWorkspaceRelative(root, target.workspace)}\0${target.state.graphId}` }))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((target) => ({ workspace: target.workspace, graphId: target.state.graphId }));
  const leases = acquireTreeLeases(leaseTargets);
  const preparedFiles: string[] = [];
  let journalPersisted = false;
  try {
    const existingTreeJournal = readEngineeringGraphTreeMigrationJournal(workspace, definition.graphId);
    if (existingTreeJournal && existingTreeJournal.phase !== "committed") {
      throw new EngineeringGraphMigrationConflictError(
        "Graph has an unresolved tree migration journal; retry recovery",
      );
    }
    const transactionId = randomUUID();
    const preparedAt = new Date().toISOString();
    const participants: EngineeringGraphTreeMigrationJournalParticipant[] = [];
    const preparedStates: Array<{ target: TreeTarget; serialized: string }> = [];
    for (const target of ordered) {
      const current = loadEngineeringGraphState(target.workspace, target.state.graphId);
      if (
        !current ||
        current.fingerprint !== target.state.fingerprint ||
        !isDeepStrictEqual(current.definition, target.state.definition) ||
        !isDeepStrictEqual(current.parentGraph, target.state.parentGraph)
      ) {
        throw new EngineeringGraphMigrationConflictError(`Graph tree migration checkpoint changed: ${target.path}`);
      }
      const built = buildTreeMigrationState(target.workspace, current, target.definition);
      const serialized = `${JSON.stringify(built.state, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > MAX_GRAPH_STATE_BYTES) {
        throw new Error(`Prepared Graph tree checkpoint exceeds the durable byte limit: ${target.path}`);
      }
      preparedStates.push({ target, serialized });
      participants.push({
        workspace: safeWorkspaceRelative(root, target.workspace),
        graphId: current.graphId,
        path: target.path,
        sourceFingerprint: current.fingerprint,
        sourceStateHash: engineeringGraphStateHash(current),
        targetFingerprint: built.state.fingerprint,
        targetStateHash: engineeringGraphStateHash(built.state),
      });
    }
    const journal: EngineeringGraphTreeMigrationJournal = {
      version: 1,
      transactionId,
      graphId: definition.graphId,
      phase: "preparing",
      preparedAt,
      participants,
    };
    const serializedJournal = `${JSON.stringify(journal)}\n`;
    if (Buffer.byteLength(serializedJournal) > MAX_TREE_JOURNAL_BYTES) {
      throw new Error("Graph tree migration journal exceeds the durable byte limit");
    }
    writeWorkspaceStateFileAtomic(workspace, treeJournalPath(definition.graphId), serializedJournal);
    journalPersisted = true;
    options.faultInjector?.("after_tree_preparing");
    for (const prepared of preparedStates) {
      const path = treePreparedPath(prepared.target.state.graphId, transactionId);
      writeWorkspaceStateFileAtomic(prepared.target.workspace, path, prepared.serialized);
      preparedFiles.push(resolve(prepared.target.workspace, path));
    }
    const preparedJournal: EngineeringGraphTreeMigrationJournal = { ...journal, phase: "prepared" };
    writeWorkspaceStateFileAtomic(
      workspace,
      treeJournalPath(definition.graphId),
      `${JSON.stringify(preparedJournal)}\n`,
    );
    options.faultInjector?.("after_tree_prepared");
    const state = commitTreeJournal(workspace, preparedJournal, options.faultInjector);
    return { plan, state, transactionId };
  } finally {
    if (!journalPersisted) {
      for (const prepared of preparedFiles) removePreparedTreeFile(prepared);
    }
    for (const lease of leases.reverse()) lease.release();
  }
}

/** Applies only an append-only definition evolution through the coordinated transaction owner. */
export function applyEngineeringGraphExpansion(
  workspace: string,
  input: unknown,
  options: EngineeringGraphTreeMigrationOptions = {},
): EngineeringGraphTreeMigrationResult {
  const definition = parseEngineeringGraphDefinition(input);
  const current = loadEngineeringGraphState(workspace, definition.graphId);
  if (!current) throw new Error(`Persisted Graph not found or invalid: ${definition.graphId}`);
  planEngineeringGraphExpansion(current.definition, definition);
  return applyEngineeringGraphTreeMigration(workspace, definition, options);
}
