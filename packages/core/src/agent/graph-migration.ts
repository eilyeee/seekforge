import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
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
  loadEngineeringGraphState,
  MAX_GRAPH_EVENTS,
  saveEngineeringGraphState,
  validateEngineeringGraphState,
  type EngineeringGraphState,
  type GraphEvent,
} from "./graph-state.js";
import { isDenseArray, orchestrationDescendantClosure } from "./orchestration.js";
import { acquireSessionLease } from "./session-lease.js";
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

/** Loads root and nested checkpoints from their resolved physical workspaces. */
export function listEngineeringGraphTreeStates(
  workspace: string,
  definitionInputs: readonly unknown[],
): EngineeringGraphState[] {
  if (!isDenseArray(definitionInputs) || definitionInputs.length === 0 || definitionInputs.length > 2) {
    throw new Error("Graph tree state discovery requires one or two dense definitions");
  }
  const states = new Map<string, EngineeringGraphState>();
  const owners = new Map<string, string>();
  const visit = (baseWorkspace: string, definition: EngineeringGraphDefinition, runtimeGraphId: string): void => {
    const physicalWorkspace = realpathSync.native(baseWorkspace);
    const state = loadEngineeringGraphState(physicalWorkspace, runtimeGraphId);
    if (state) {
      const existing = states.get(runtimeGraphId);
      if (existing && (owners.get(runtimeGraphId) !== physicalWorkspace || !isDeepStrictEqual(existing, state))) {
        throw new Error(`Graph tree contains conflicting checkpoint identities: ${runtimeGraphId}`);
      }
      states.set(runtimeGraphId, state);
      owners.set(runtimeGraphId, physicalWorkspace);
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
  return [...states.values()].sort((left, right) => left.graphId.localeCompare(right.graphId));
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
  if (requiresTreeTransaction) {
    blockers.push("Nested or multiple checkpoints require a coordinated tree transaction; apply remains fail-closed");
  }
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

function finishCommittedMigration(
  workspace: string,
  state: EngineeringGraphState,
  journal: EngineeringGraphMigrationJournal,
): void {
  if (!migrationJournalTargetsState(journal, state)) return;
  const migrated = [...state.events].reverse().find((event) => event.type === "graph.migrated");
  if (migrated) {
    const retained = readEngineeringGraphHistory(workspace, state.graphId, { limit: 2_000, tail: true });
    const alreadyRecorded = retained.some((entry) => entry.event.sequence === migrated.sequence);
    const latestEventSequence = retained.at(-1)?.event.sequence ?? 0;
    if (!alreadyRecorded && latestEventSequence < migrated.sequence) {
      try {
        const writer = createEngineeringGraphLogWriter(workspace, state.graphId);
        writer.append(migrated);
        writer.close();
      } catch {
        // The checkpoint event remains authoritative when history repair fails.
      }
    }
  }
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
