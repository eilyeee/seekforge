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
import { acquireSessionLease, isSessionRunActive } from "./session-lease.js";

export const MAX_GRAPH_STATE_BYTES = 1024 * 1024;
export const MAX_GRAPH_EVENTS = 128;
export const MAX_GRAPH_EVENT_MESSAGE_CHARS = 1024;
export const MAX_GRAPH_OUTPUT_BYTES = 16 * 1024;
export const MAX_GRAPH_OUTPUT_TOTAL_BYTES = 128 * 1024;

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
  artifacts?: Array<{ name: string; path: string; sha256?: string }>;
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
};

export type GraphEvent = {
  sequence: number;
  type:
    | "graph.started"
    | "graph.resumed"
    | "graph.paused"
    | "graph.controlled"
    | "graph.completed"
    | "node.started"
    | "node.attempt.started"
    | "node.attempt.settled"
    | "node.completed"
    | "node.skipped"
    | "node.waiting_approval"
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
  activeAttempts: GraphActiveAttempt[];
  controlSeq: number;
  controlRunId: string;
  pauseReason?: "approval" | "control";
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

function parseNodeResult(value: unknown, definition: EngineeringGraphDefinition): GraphNodeResult | null {
  if (!isRecord(value)) return null;
  const node = definition.nodes.find((candidate) => candidate.id === value.id);
  const status = String(value.status);
  if (
    !node ||
    value.kind !== node.kind ||
    !["passed", "failed", "skipped", "waiting_approval"].includes(status) ||
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
    (value.artifacts !== undefined &&
      (!isDenseArray(value.artifacts) ||
        value.artifacts.length > 32 ||
        value.artifacts.some(
          (artifact) =>
            !isRecord(artifact) ||
            typeof artifact.name !== "string" ||
            !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(artifact.name) ||
            !isSafeLoopDagRelativePath(artifact.path) ||
            (artifact.sha256 !== undefined &&
              (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256))),
        )))
  ) {
    return null;
  }
  if (
    ((status === "failed" || status === "skipped") && typeof value.error !== "string") ||
    ((status === "passed" || status === "waiting_approval") && value.error !== undefined) ||
    ((status === "passed" || status === "failed") && !validTimestamp(value.startedAt)) ||
    (status === "skipped" && value.attempts !== 0) ||
    (status === "waiting_approval" &&
      ((node.kind === "gate" && value.attempts !== 0) ||
        (node.kind === "subgraph" && (value.attempts as number) < 1) ||
        (node.kind !== "gate" && node.kind !== "subgraph"))) ||
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
    "graph.completed",
    "node.started",
    "node.attempt.started",
    "node.attempt.settled",
    "node.completed",
    "node.skipped",
    "node.waiting_approval",
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
      !["running", "paused", "passed", "failed", "cancelled", "skipped", "waiting_approval"].includes(
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
    !Array.isArray(activeAttempts) ||
    activeAttempts.length > definitionNodeLimit(value.definition) ||
    !Number.isSafeInteger(controlSeq) ||
    (controlSeq as number) < 0 ||
    typeof controlRunId !== "string" ||
    (controlRunId !== "" && !isValidLoopDagId(controlRunId)) ||
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
    (pauseReason !== undefined && pauseReason !== "approval" && pauseReason !== "control")
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
    if (
      !isRecord(attempt) ||
      !definition.nodes.some((node) => node.id === attempt.nodeId) ||
      attemptNodes.has(attempt.nodeId as string) ||
      !Number.isSafeInteger(attempt.attempt) ||
      (attempt.attempt as number) < 1 ||
      (attempt.attempt as number) > 6 ||
      typeof attempt.idempotencyKey !== "string" ||
      attempt.idempotencyKey.length === 0 ||
      attempt.idempotencyKey.length > 512 ||
      !validTimestamp(attempt.startedAt)
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
  for (const result of results) {
    const node = definition.nodes.find((candidate) => candidate.id === result!.id)!;
    if ((node.dependsOn ?? []).some((dependency) => !resultIds.has(dependency))) return null;
  }
  const fanIn = parseFanIn(value.fanIn);
  if (fanIn === null || (fanIn !== undefined && definition.fanIn === undefined)) return null;
  if ((fanIn?.status === "failed" && !fanIn.error) || (fanIn?.status === "passed" && fanIn.error !== undefined)) {
    return null;
  }
  const spentCost = results.reduce((sum, result) => sum + result!.costUsd, 0) + (fanIn?.costUsd ?? 0);
  const spentTokens = results.reduce((sum, result) => sum + result!.tokensUsed, 0) + (fanIn?.tokensUsed ?? 0);
  if (Math.abs(spentCost - value.spentCost) > 1e-9 || spentTokens !== value.spentTokens) return null;
  const status = value.status as GraphRunStatus;
  const hasWaiting = results.some((result) => result!.status === "waiting_approval");
  const hasFailed = results.some((result) => result!.status === "failed");
  const terminal = status === "passed" || status === "failed" || status === "cancelled";
  if (
    (status === "paused" && pauseReason === undefined) ||
    (status === "paused" && pauseReason === "approval" && !hasWaiting) ||
    (status === "paused" && pauseReason === "control" && hasWaiting) ||
    (status !== "paused" && hasWaiting) ||
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
    controlSeq: controlSeq as number,
    controlRunId,
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
  options: { limit?: number } = {},
): EngineeringGraphState[] {
  const limit = options.limit ?? 3;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("Graph recovery limit must be 1 to 100");
  return listEngineeringGraphStates(workspace)
    .filter(
      (state) =>
        state.parentGraph === undefined &&
        (state.status === "running" || (state.status === "paused" && state.pauseReason === "control")) &&
        !isSessionRunActive(workspace, `engineering-graph-${state.graphId}`),
    )
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .slice(0, limit);
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
