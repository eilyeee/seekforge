import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  type EngineeringGraphDefinition,
  type GraphNodeKind,
  type GraphNodeStatus,
  type GraphRunStatus,
  MAX_GRAPH_HISTORY_SEGMENTS,
  parseEngineeringGraphDefinition,
} from "./graph-contract.js";
import { isSafeLoopDagRelativePath, isValidLoopDagId } from "./loop-dag-validation.js";
import { MANAGED_ORCHESTRATION_BRANCH_RE } from "./loop-managed-worktree.js";
import { isDenseArray } from "./orchestration.js";
import {
  automaticRecoveryEligible,
  automaticRecoveryTime,
  compareAutomaticRecoveryCandidates,
  nextAutomaticRecoveryMetadata,
  parseAutomaticRecoveryMetadata,
  type AutomaticRecoveryMetadata,
} from "./recovery-policy.js";
import { engineeringGraphSignalAvailable } from "./graph-signal-store.js";
import { acquireSessionLease, isSessionRunActive, type SessionLease } from "./session-lease.js";

export const MAX_GRAPH_STATE_BYTES = 1024 * 1024;
export const MAX_GRAPH_EVENTS = 128;
export const MAX_GRAPH_EVENT_MESSAGE_CHARS = 1024;
export const MAX_GRAPH_OUTPUT_BYTES = 16 * 1024;
export const MAX_GRAPH_OUTPUT_TOTAL_BYTES = 128 * 1024;

export type GraphArtifact = {
  name: string;
  path: string;
  sha256?: string;
  sizeBytes?: number;
  producerNodeId?: string;
  verified?: boolean;
};

export type GraphMapItemResult = {
  index: number;
  idempotencyKey: string;
  output?: unknown;
  costUsd: number;
  tokensUsed: number;
  artifacts?: GraphArtifact[];
  completedAt: string;
};

export type GraphNodeResult = {
  id: string;
  kind: GraphNodeKind;
  status: GraphNodeStatus;
  attempts: number;
  costUsd: number;
  tokensUsed: number;
  startedAt?: string;
  completedAt?: string;
  sessionId?: string;
  output?: unknown;
  error?: string;
  managedBranch?: string;
  artifacts?: GraphArtifact[];
};

export type EngineeringGraphFanInResult = {
  status: "passed" | "failed";
  workspace: string;
  branch: string;
  costUsd: number;
  tokensUsed: number;
  updatedAt: string;
  error?: string;
};

export type GraphActiveAttempt = {
  nodeId: string;
  attempt: number;
  idempotencyKey: string;
  startedAt: string;
  phase?: "running" | "waiting_retry";
  nextAttemptAt?: string;
  lastError?: string;
};

export type GraphEvent = {
  sequence: number;
  type:
    | "graph.started"
    | "graph.resumed"
    | "graph.paused"
    | "graph.controlled"
    | "graph.migrated"
    | "graph.completed"
    | "node.started"
    | "node.attempt.started"
    | "node.attempt.settled"
    | "node.completed"
    | "node.skipped"
    | "node.waiting_approval"
    | "node.waiting_signal"
    | "map.item.completed"
    | "graph.compensating"
    | "fan_in.started"
    | "fan_in.completed"
    | "graph.warning";
  timestamp: string;
  nodeId?: string;
  status?: GraphNodeStatus | GraphRunStatus;
  message?: string;
};

export type EngineeringGraphState = {
  schemaVersion: 2;
  graphId: string;
  fingerprint: string;
  status: GraphRunStatus;
  definition: EngineeringGraphDefinition;
  results: GraphNodeResult[];
  events: GraphEvent[];
  spentCost: number;
  spentTokens: number;
  /** Cumulative active runtime; paused/offline wall time is excluded. */
  elapsedMs: number;
  activeAttempts: GraphActiveAttempt[];
  /** Successful map items are committed before their sibling batch settles. */
  mapProgress?: Record<string, GraphMapItemResult[]>;
  controlSeq: number;
  controlRunId: string;
  /** Mutable ordering for automatic recovery; independent from node priority. */
  priority: number;
  recovery?: AutomaticRecoveryMetadata;
  recoveryAttemptId?: string;
  pauseReason?: "approval" | "control" | "wait";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  parentGraph?: { graphId: string; nodeId: string };
  resourceGeneration?: string;
  fanIn?: EngineeringGraphFanInResult;
};

function statePath(graphId: string): string {
  return `.seekforge/graphs/${graphId}.json`;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseArtifacts(value: unknown, producerNodeId?: string): GraphArtifact[] | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isDenseArray(value) ||
    value.length > 32 ||
    value.some(
      (artifact) =>
        !isRecord(artifact) ||
        typeof artifact.name !== "string" ||
        !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(artifact.name) ||
        !isSafeLoopDagRelativePath(artifact.path) ||
        (artifact.sha256 !== undefined &&
          (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256))) ||
        (artifact.sizeBytes !== undefined &&
          (!Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 0)) ||
        (artifact.producerNodeId !== undefined &&
          (!isValidLoopDagId(artifact.producerNodeId) || artifact.producerNodeId !== producerNodeId)) ||
        (artifact.verified !== undefined && typeof artifact.verified !== "boolean") ||
        (artifact.verified === true && (artifact.sha256 === undefined || artifact.sizeBytes === undefined)),
    )
  ) {
    return null;
  }
  return value as GraphArtifact[];
}

function parseNodeResult(value: unknown, definition: EngineeringGraphDefinition): GraphNodeResult | null {
  if (!isRecord(value)) return null;
  const node = definition.nodes.find((candidate) => candidate.id === value.id);
  const status = String(value.status);
  if (
    !node ||
    value.kind !== node.kind ||
    !["passed", "failed", "skipped", "waiting_approval", "waiting_signal"].includes(status) ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    !finiteNonNegative(value.costUsd) ||
    !Number.isSafeInteger(value.tokensUsed) ||
    (value.tokensUsed as number) < 0 ||
    (value.startedAt !== undefined && !validTimestamp(value.startedAt)) ||
    !validTimestamp(value.completedAt) ||
    (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 256)) ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8_192)) ||
    (value.output !== undefined && Buffer.byteLength(JSON.stringify(value.output)) > MAX_GRAPH_OUTPUT_BYTES) ||
    (value.managedBranch !== undefined &&
      (typeof value.managedBranch !== "string" || !MANAGED_ORCHESTRATION_BRANCH_RE.test(value.managedBranch))) ||
    parseArtifacts(value.artifacts, node.id) === null
  ) {
    return null;
  }
  if (
    ((status === "failed" || status === "skipped") && typeof value.error !== "string") ||
    ((status === "passed" || status === "waiting_approval" || status === "waiting_signal") &&
      value.error !== undefined) ||
    ((status === "passed" || status === "failed") && !validTimestamp(value.startedAt)) ||
    (status === "skipped" && value.attempts !== 0) ||
    (status === "waiting_approval" &&
      ((node.kind === "gate" && value.attempts !== 0) ||
        (node.kind === "subgraph" && (value.attempts as number) < 1) ||
        (node.kind !== "gate" && node.kind !== "subgraph"))) ||
    (status === "waiting_signal" && (node.kind !== "wait" || value.attempts !== 0)) ||
    (validTimestamp(value.startedAt) && Date.parse(value.completedAt) < Date.parse(value.startedAt))
  ) {
    return null;
  }
  return value as GraphNodeResult;
}

function parseFanIn(value: unknown): EngineeringGraphFanInResult | undefined | null {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    (value.status !== "passed" && value.status !== "failed") ||
    typeof value.workspace !== "string" ||
    typeof value.branch !== "string" ||
    !MANAGED_ORCHESTRATION_BRANCH_RE.test(value.branch) ||
    !finiteNonNegative(value.costUsd) ||
    !Number.isSafeInteger(value.tokensUsed) ||
    (value.tokensUsed as number) < 0 ||
    !validTimestamp(value.updatedAt) ||
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8_192))
  ) {
    return null;
  }
  return value as EngineeringGraphFanInResult;
}

export function parseGraphEvent(value: unknown, previousSequence = 0): GraphEvent | null {
  if (!isRecord(value)) return null;
  const types = new Set<GraphEvent["type"]>([
    "graph.started",
    "graph.resumed",
    "graph.paused",
    "graph.controlled",
    "graph.migrated",
    "graph.completed",
    "node.started",
    "node.attempt.started",
    "node.attempt.settled",
    "node.completed",
    "node.skipped",
    "node.waiting_approval",
    "node.waiting_signal",
    "map.item.completed",
    "graph.compensating",
    "fan_in.started",
    "fan_in.completed",
    "graph.warning",
  ]);
  if (
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) <= previousSequence ||
    !types.has(value.type as GraphEvent["type"]) ||
    !validTimestamp(value.timestamp) ||
    (value.nodeId !== undefined && !isValidLoopDagId(value.nodeId)) ||
    (value.status !== undefined &&
      !["running", "paused", "passed", "failed", "cancelled", "skipped", "waiting_approval", "waiting_signal"].includes(
        String(value.status),
      )) ||
    (value.message !== undefined &&
      (typeof value.message !== "string" || value.message.length > MAX_GRAPH_EVENT_MESSAGE_CHARS))
  ) {
    return null;
  }
  return value as GraphEvent;
}

function parseState(raw: string, expectedId?: string): EngineeringGraphState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
    !isValidLoopDagId(value.graphId)
  ) {
    return null;
  }
  if (expectedId !== undefined && value.graphId !== expectedId) return null;
  const activeAttempts = value.schemaVersion === 1 ? [] : value.activeAttempts;
  const controlSeq = value.schemaVersion === 1 ? 0 : value.controlSeq;
  const controlRunId = value.schemaVersion === 1 ? "" : value.controlRunId;
  const pauseReason = value.schemaVersion === 1 && value.status === "paused" ? "approval" : value.pauseReason;
  const mapProgressValue = value.schemaVersion === 1 ? undefined : value.mapProgress;
  const elapsedMs = value.schemaVersion === 1 || value.elapsedMs === undefined ? 0 : value.elapsedMs;
  const priority = value.priority ?? 0;
  const recovery = parseAutomaticRecoveryMetadata(value.recovery);
  const recoveryAttemptId = value.recoveryAttemptId;
  if (
    typeof value.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
    !["running", "paused", "passed", "failed", "cancelled"].includes(String(value.status)) ||
    !Array.isArray(value.results) ||
    !Array.isArray(value.events) ||
    value.events.length > MAX_GRAPH_EVENTS ||
    !finiteNonNegative(value.spentCost) ||
    !Number.isSafeInteger(value.spentTokens) ||
    (value.spentTokens as number) < 0 ||
    !Number.isSafeInteger(elapsedMs) ||
    (elapsedMs as number) < 0 ||
    !Array.isArray(activeAttempts) ||
    activeAttempts.length > definitionNodeLimit(value.definition) ||
    !Number.isSafeInteger(controlSeq) ||
    (controlSeq as number) < 0 ||
    typeof controlRunId !== "string" ||
    (controlRunId !== "" && !isValidLoopDagId(controlRunId)) ||
    !Number.isSafeInteger(priority) ||
    (priority as number) < -10 ||
    (priority as number) > 10 ||
    recovery === null ||
    (recoveryAttemptId !== undefined && !isValidLoopDagId(recoveryAttemptId)) ||
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    (value.completedAt !== undefined && !validTimestamp(value.completedAt)) ||
    (value.parentGraph !== undefined &&
      (!isRecord(value.parentGraph) ||
        !isValidLoopDagId(value.parentGraph.graphId) ||
        !isValidLoopDagId(value.parentGraph.nodeId))) ||
    (value.resourceGeneration !== undefined &&
      (typeof value.resourceGeneration !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.resourceGeneration))) ||
    (pauseReason !== undefined && pauseReason !== "approval" && pauseReason !== "control" && pauseReason !== "wait")
  ) {
    return null;
  }
  let definition: EngineeringGraphDefinition;
  try {
    definition = parseEngineeringGraphDefinition(value.definition);
  } catch {
    return null;
  }
  if (definition.graphId !== value.graphId || value.results.length > definition.nodes.length) return null;
  const parsedAttempts: GraphActiveAttempt[] = [];
  const attemptNodes = new Set<string>();
  for (const attempt of activeAttempts) {
    const attemptNode = isRecord(attempt) ? definition.nodes.find((node) => node.id === attempt.nodeId) : undefined;
    if (
      !isRecord(attempt) ||
      !attemptNode ||
      attemptNodes.has(attempt.nodeId as string) ||
      !Number.isSafeInteger(attempt.attempt) ||
      (attempt.attempt as number) < 1 ||
      (attempt.attempt as number) > (attemptNode.maxRetries ?? 0) + 1 ||
      typeof attempt.idempotencyKey !== "string" ||
      attempt.idempotencyKey.length === 0 ||
      attempt.idempotencyKey.length > 512 ||
      !validTimestamp(attempt.startedAt) ||
      (attempt.phase !== undefined && attempt.phase !== "running" && attempt.phase !== "waiting_retry") ||
      (attempt.nextAttemptAt !== undefined && !validTimestamp(attempt.nextAttemptAt)) ||
      (attempt.lastError !== undefined &&
        (typeof attempt.lastError !== "string" || attempt.lastError.length < 1 || attempt.lastError.length > 8_192)) ||
      (attempt.phase === "waiting_retry" &&
        (!validTimestamp(attempt.nextAttemptAt) ||
          typeof attempt.lastError !== "string" ||
          (attempt.attempt as number) > (attemptNode.maxRetries ?? 0))) ||
      (attempt.phase !== "waiting_retry" && (attempt.nextAttemptAt !== undefined || attempt.lastError !== undefined))
    ) {
      return null;
    }
    attemptNodes.add(attempt.nodeId as string);
    parsedAttempts.push(attempt as GraphActiveAttempt);
  }
  const results = value.results.map((result) => parseNodeResult(result, definition));
  if (results.some((result) => result === null)) return null;
  const resultIds = new Set(results.map((result) => result!.id));
  if (resultIds.size !== results.length || parsedAttempts.some((attempt) => resultIds.has(attempt.nodeId))) return null;
  const retainedOutputBytes = results.reduce(
    (total, result) => total + (result!.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(result!.output))),
    0,
  );
  if (retainedOutputBytes > MAX_GRAPH_OUTPUT_TOTAL_BYTES) return null;
  let mapProgress: Record<string, GraphMapItemResult[]> | undefined;
  if (mapProgressValue !== undefined) {
    if (!isRecord(mapProgressValue) || Object.keys(mapProgressValue).length > definition.nodes.length) return null;
    mapProgress = Object.create(null) as Record<string, GraphMapItemResult[]>;
    let progressOutputBytes = 0;
    for (const [nodeId, rawItems] of Object.entries(mapProgressValue)) {
      const node = definition.nodes.find((candidate) => candidate.id === nodeId);
      if (node?.kind !== "map" || !isDenseArray(rawItems) || rawItems.length > (node.maxItems ?? 32)) return null;
      const indexes = new Set<number>();
      const items: GraphMapItemResult[] = [];
      let artifactCount = 0;
      for (const rawItem of rawItems) {
        if (
          !isRecord(rawItem) ||
          !Number.isSafeInteger(rawItem.index) ||
          (rawItem.index as number) < 0 ||
          (rawItem.index as number) >= (node.maxItems ?? 32) ||
          indexes.has(rawItem.index as number) ||
          typeof rawItem.idempotencyKey !== "string" ||
          rawItem.idempotencyKey.length === 0 ||
          rawItem.idempotencyKey.length > 512 ||
          !finiteNonNegative(rawItem.costUsd) ||
          !Number.isSafeInteger(rawItem.tokensUsed) ||
          (rawItem.tokensUsed as number) < 0 ||
          !validTimestamp(rawItem.completedAt) ||
          parseArtifacts(rawItem.artifacts, nodeId) === null
        ) {
          return null;
        }
        if (rawItem.output !== undefined) {
          const bytes = Buffer.byteLength(JSON.stringify(rawItem.output));
          if (bytes > MAX_GRAPH_OUTPUT_BYTES) return null;
          progressOutputBytes += bytes;
        }
        indexes.add(rawItem.index as number);
        artifactCount += Array.isArray(rawItem.artifacts) ? rawItem.artifacts.length : 0;
        if (artifactCount > 32) return null;
        items.push(rawItem as GraphMapItemResult);
      }
      mapProgress[nodeId] = items.sort((left, right) => left.index - right.index);
    }
    if (retainedOutputBytes + progressOutputBytes > MAX_GRAPH_OUTPUT_TOTAL_BYTES) return null;
  }
  for (const result of results) {
    const node = definition.nodes.find((candidate) => candidate.id === result!.id)!;
    if ((node.dependsOn ?? []).some((dependency) => !resultIds.has(dependency))) return null;
  }
  const fanIn = parseFanIn(value.fanIn);
  if (fanIn === null || (fanIn !== undefined && definition.fanIn === undefined)) return null;
  if ((fanIn?.status === "failed" && !fanIn.error) || (fanIn?.status === "passed" && fanIn.error !== undefined)) {
    return null;
  }
  // Progress for a terminal map result is retained only as retry material and
  // is therefore excluded from totals until that result is invalidated.
  const uncommittedMapItems = Object.entries(mapProgress ?? {}).flatMap(([nodeId, items]) =>
    resultIds.has(nodeId) ? [] : items,
  );
  const spentCost =
    results.reduce((sum, result) => sum + result!.costUsd, 0) +
    uncommittedMapItems.reduce((sum, item) => sum + item.costUsd, 0) +
    (fanIn?.costUsd ?? 0);
  const spentTokens =
    results.reduce((sum, result) => sum + result!.tokensUsed, 0) +
    uncommittedMapItems.reduce((sum, item) => sum + item.tokensUsed, 0) +
    (fanIn?.tokensUsed ?? 0);
  if (Math.abs(spentCost - value.spentCost) > 1e-9 || spentTokens !== value.spentTokens) return null;
  const status = value.status as GraphRunStatus;
  const hasWaiting = results.some((result) => result!.status === "waiting_approval");
  const hasWaitingSignal = results.some((result) => result!.status === "waiting_signal");
  const hasFailed = results.some((result) => result!.status === "failed");
  const terminal = status === "passed" || status === "failed" || status === "cancelled";
  if (
    (status === "paused" && pauseReason === undefined) ||
    (status === "paused" && pauseReason === "approval" && (!hasWaiting || hasWaitingSignal)) ||
    (status === "paused" && pauseReason === "wait" && (!hasWaitingSignal || hasWaiting)) ||
    (status === "paused" && pauseReason === "control" && hasWaiting) ||
    (status === "paused" && pauseReason === "control" && hasWaitingSignal) ||
    (status !== "paused" && (hasWaiting || hasWaitingSignal)) ||
    (status !== "paused" && pauseReason !== undefined) ||
    (status === "passed" && hasFailed) ||
    (terminal && results.length !== definition.nodes.length) ||
    (terminal && value.completedAt === undefined) ||
    ((status === "running" || status === "paused") && value.completedAt !== undefined) ||
    (fanIn?.status === "failed" && status === "passed") ||
    (status === "passed" && definition.fanIn !== undefined && fanIn?.status !== "passed")
  ) {
    return null;
  }
  if (status !== "running" && parsedAttempts.length > 0) return null;
  let sequence = 0;
  const events: GraphEvent[] = [];
  for (const event of value.events) {
    const parsed = parseGraphEvent(event, sequence);
    if (!parsed) return null;
    sequence = parsed.sequence;
    events.push(parsed);
  }
  return {
    ...(value as EngineeringGraphState),
    schemaVersion: 2,
    definition,
    results: results as GraphNodeResult[],
    events,
    activeAttempts: parsedAttempts,
    elapsedMs: elapsedMs as number,
    ...(mapProgress ? { mapProgress } : {}),
    controlSeq: controlSeq as number,
    controlRunId,
    priority: priority as number,
    ...(recovery ? { recovery } : {}),
    ...(typeof recoveryAttemptId === "string" ? { recoveryAttemptId } : {}),
    ...(pauseReason ? { pauseReason } : {}),
    ...(fanIn ? { fanIn } : {}),
  };
}

function definitionNodeLimit(value: unknown): number {
  return isRecord(value) && Array.isArray(value.nodes) ? Math.min(value.nodes.length, 128) : 128;
}

export function saveEngineeringGraphState(workspace: string, state: EngineeringGraphState): void {
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_GRAPH_STATE_BYTES) throw new Error("Graph checkpoint exceeds 1 MiB");
  writeWorkspaceStateFileAtomic(workspace, statePath(state.graphId), serialized);
}

/** Validates a newly constructed checkpoint against the persisted contract before effects. */
export function validateEngineeringGraphState(state: EngineeringGraphState): EngineeringGraphState {
  const serialized = JSON.stringify(state);
  const parsed = parseState(serialized, state.graphId);
  if (!parsed) throw new Error(`Engineering Graph state is invalid: ${state.graphId}`);
  return parsed;
}

export function loadEngineeringGraphState(workspace: string, graphId: string): EngineeringGraphState | null {
  if (!isValidLoopDagId(graphId)) return null;
  const raw = readWorkspaceStateFile(workspace, statePath(graphId), MAX_GRAPH_STATE_BYTES);
  return raw === undefined ? null : parseState(raw, graphId);
}

export function engineeringGraphStateExists(workspace: string, graphId: string): boolean {
  if (!isValidLoopDagId(graphId)) return false;
  return readWorkspaceStateFile(workspace, statePath(graphId), MAX_GRAPH_STATE_BYTES) !== undefined;
}

export function listEngineeringGraphStates(workspace: string): EngineeringGraphState[] {
  const root = realpathSync.native(workspace);
  const directory = join(root, ".seekforge", "graphs");
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !realpathSync.native(directory).startsWith(`${root}${sep}`)) {
      return [];
    }
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".json"))
      .slice(0, 256)
      .flatMap((entry) => {
        try {
          const state = loadEngineeringGraphState(workspace, entry.name.slice(0, -5));
          return state ? [state] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function recoverableEngineeringGraphStates(
  workspace: string,
  options: { limit?: number; now?: Date } = {},
): EngineeringGraphState[] {
  const limit = options.limit ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Graph recovery limit must be 1 to 100");
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Graph recovery time must be valid");
  return listEngineeringGraphStates(workspace)
    .filter((state) => {
      const waitDue =
        state.status === "paused" &&
        state.pauseReason === "wait" &&
        state.results.some((result) => {
          if (result.status !== "waiting_signal") return false;
          const node = state.definition.nodes.find((candidate) => candidate.id === result.id);
          return [node?.waitFor?.notBefore, node?.waitFor?.expiresAt].some(
            (timestamp) => timestamp !== undefined && Date.parse(timestamp) <= nowMs,
          );
        });
      const signalReady =
        state.status === "paused" &&
        state.pauseReason === "wait" &&
        state.results.some((result) => {
          if (result.status !== "waiting_signal") return false;
          const node = state.definition.nodes.find((candidate) => candidate.id === result.id);
          if (!node?.waitFor?.signal) return false;
          try {
            return engineeringGraphSignalAvailable(
              workspace,
              state.graphId,
              node.id,
              node.waitFor.signal,
              node.waitFor.expiresAt,
            );
          } catch {
            return false;
          }
        });
      return (
        state.parentGraph === undefined &&
        (state.status === "running" || waitDue || signalReady) &&
        automaticRecoveryEligible(state.recovery, nowMs) &&
        !isSessionRunActive(workspace, `engineering-graph-${state.graphId}`)
      );
    })
    .sort(compareAutomaticRecoveryCandidates)
    .slice(0, limit);
}

/** Persists bounded backoff only when the failed invocation still owns the checkpoint generation. */
export function recordEngineeringGraphRecoveryFailure(
  workspace: string,
  graphId: string,
  identity: { priorControlRunId: string; recoveryAttemptId: string },
  error: unknown,
  now = new Date(),
  workspaceGuard?: SessionLease,
): EngineeringGraphState {
  if (
    !isValidLoopDagId(graphId) ||
    (identity.priorControlRunId !== "" && !isValidLoopDagId(identity.priorControlRunId)) ||
    !isValidLoopDagId(identity.recoveryAttemptId)
  ) {
    throw new Error("Graph recovery identity is invalid");
  }
  const { nowIso } = automaticRecoveryTime(now);
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`, workspaceGuard);
  try {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) throw new Error(`Persisted Graph not found or invalid: ${graphId}`);
    if (state.controlRunId !== identity.priorControlRunId && state.recoveryAttemptId !== identity.recoveryAttemptId) {
      return state;
    }
    const next: EngineeringGraphState = {
      ...state,
      recovery: nextAutomaticRecoveryMetadata(state.recovery, error, now),
      updatedAt: nowIso,
    };
    saveEngineeringGraphState(workspace, next);
    return next;
  } finally {
    lease.release();
  }
}

/** Clears recovery backoff after the matching invocation returns normally. */
export function clearEngineeringGraphRecovery(
  workspace: string,
  graphId: string,
  controlRunId: string,
  workspaceGuard?: SessionLease,
): EngineeringGraphState {
  if (!isValidLoopDagId(graphId) || !isValidLoopDagId(controlRunId))
    throw new Error("Graph recovery identity is invalid");
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`, workspaceGuard);
  try {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) throw new Error(`Persisted Graph not found or invalid: ${graphId}`);
    if (
      state.controlRunId !== controlRunId ||
      (state.recovery === undefined && state.recoveryAttemptId === undefined)
    ) {
      return state;
    }
    const { recovery: _recovery, recoveryAttemptId: _recoveryAttemptId, ...retained } = state;
    const next: EngineeringGraphState = { ...retained, updatedAt: new Date().toISOString() };
    saveEngineeringGraphState(workspace, next);
    return next;
  } finally {
    lease.release();
  }
}

export function setEngineeringGraphPriority(
  workspace: string,
  graphId: string,
  priority: number,
): EngineeringGraphState {
  if (!isValidLoopDagId(graphId)) throw new Error(`Graph id must be safe: ${graphId}`);
  if (!Number.isSafeInteger(priority) || priority < -10 || priority > 10) {
    throw new RangeError("Graph priority must be an integer from -10 to 10");
  }
  const lease = acquireSessionLease(workspace, `engineering-graph-${graphId}`);
  try {
    const state = loadEngineeringGraphState(workspace, graphId);
    if (!state) throw new Error(`Persisted Graph not found or invalid: ${graphId}`);
    const next = { ...state, priority, updatedAt: new Date().toISOString() };
    saveEngineeringGraphState(workspace, next);
    return next;
  } finally {
    lease.release();
  }
}

export function removeEngineeringGraphState(workspace: string, graphId: string): boolean {
  if (!isValidLoopDagId(graphId)) throw new Error(`Graph id must be safe: ${graphId}`);
  const leaseId = `engineering-graph-${graphId}`;
  if (isSessionRunActive(workspace, leaseId)) throw new Error(`Graph is currently running: ${graphId}`);
  const lease = acquireSessionLease(workspace, leaseId);
  try {
    const root = realpathSync.native(workspace);
    const directory = join(root, ".seekforge", "graphs");
    const targets = [
      join(directory, `${graphId}.json`),
      join(directory, `${graphId}.control.json`),
      join(directory, `${graphId}.signals.json`),
      join(directory, `${graphId}.runs.json`),
      ...Array.from({ length: MAX_GRAPH_HISTORY_SEGMENTS }, (_, index) =>
        join(directory, `${graphId}.jsonl${index === 0 ? "" : `.${index}`}`),
      ),
      join(root, ".seekforge", "graph-archives", `${graphId}.json`),
    ];
    const artifacts = targets.map((target) => ({ target, stat: lstatSync(target, { throwIfNoEntry: false }) }));
    if (artifacts[0]!.stat === undefined) return false;
    for (const artifact of artifacts) {
      if (artifact.stat === undefined) continue;
      if (
        !artifact.stat.isFile() ||
        artifact.stat.isSymbolicLink() ||
        realpathSync.native(artifact.target) !== artifact.target ||
        !artifact.target.startsWith(`${root}${sep}`)
      ) {
        throw new Error(`Graph artifact is not a physical workspace file: ${graphId}`);
      }
    }
    for (const artifact of artifacts) if (artifact.stat !== undefined) rmSync(artifact.target);
    return true;
  } finally {
    lease.release();
  }
}
