import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import {
  type EngineeringGraphDefinition,
  type GraphNodeKind,
  type GraphNodeStatus,
  type GraphRunStatus,
  parseEngineeringGraphDefinition,
} from "./graph-contract.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { acquireSessionLease, isSessionRunActive } from "./session-lease.js";

export const MAX_GRAPH_STATE_BYTES = 1024 * 1024;
export const MAX_GRAPH_EVENTS = 128;
export const MAX_GRAPH_EVENT_MESSAGE_CHARS = 1024;

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
};

export type GraphEvent = {
  sequence: number;
  type:
    | "graph.started"
    | "graph.resumed"
    | "graph.paused"
    | "graph.completed"
    | "node.started"
    | "node.completed"
    | "node.skipped"
    | "node.waiting_approval"
    | "graph.warning";
  timestamp: string;
  nodeId?: string;
  status?: GraphNodeStatus | GraphRunStatus;
  message?: string;
};

export type EngineeringGraphState = {
  schemaVersion: 1;
  graphId: string;
  fingerprint: string;
  status: GraphRunStatus;
  definition: EngineeringGraphDefinition;
  results: GraphNodeResult[];
  events: GraphEvent[];
  spentCost: number;
  spentTokens: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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
    (value.error !== undefined && (typeof value.error !== "string" || value.error.length > 8_192))
  ) {
    return null;
  }
  if (
    ((status === "failed" || status === "skipped") && typeof value.error !== "string") ||
    ((status === "passed" || status === "waiting_approval") && value.error !== undefined) ||
    ((status === "passed" || status === "failed") && !validTimestamp(value.startedAt)) ||
    ((status === "skipped" || status === "waiting_approval") && value.attempts !== 0) ||
    (validTimestamp(value.startedAt) && Date.parse(value.completedAt) < Date.parse(value.startedAt))
  ) {
    return null;
  }
  return value as GraphNodeResult;
}

function parseEvent(value: unknown, previousSequence: number): GraphEvent | null {
  if (!isRecord(value)) return null;
  const types = new Set<GraphEvent["type"]>([
    "graph.started",
    "graph.resumed",
    "graph.paused",
    "graph.completed",
    "node.started",
    "node.completed",
    "node.skipped",
    "node.waiting_approval",
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
  if (!isRecord(value) || value.schemaVersion !== 1 || !isValidLoopDagId(value.graphId)) return null;
  if (expectedId !== undefined && value.graphId !== expectedId) return null;
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
    !validTimestamp(value.createdAt) ||
    !validTimestamp(value.updatedAt) ||
    (value.completedAt !== undefined && !validTimestamp(value.completedAt))
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
  const results = value.results.map((result) => parseNodeResult(result, definition));
  if (results.some((result) => result === null)) return null;
  const resultIds = new Set(results.map((result) => result!.id));
  if (resultIds.size !== results.length) return null;
  for (const result of results) {
    const node = definition.nodes.find((candidate) => candidate.id === result!.id)!;
    if ((node.dependsOn ?? []).some((dependency) => !resultIds.has(dependency))) return null;
  }
  const spentCost = results.reduce((sum, result) => sum + result!.costUsd, 0);
  const spentTokens = results.reduce((sum, result) => sum + result!.tokensUsed, 0);
  if (Math.abs(spentCost - value.spentCost) > 1e-9 || spentTokens !== value.spentTokens) return null;
  const status = value.status as GraphRunStatus;
  const hasWaiting = results.some((result) => result!.status === "waiting_approval");
  const hasFailed = results.some((result) => result!.status === "failed");
  const terminal = status === "passed" || status === "failed" || status === "cancelled";
  if (
    (status === "paused" && !hasWaiting) ||
    (status !== "paused" && hasWaiting) ||
    (status === "passed" && hasFailed) ||
    (terminal && results.length !== definition.nodes.length) ||
    (terminal && value.completedAt === undefined) ||
    ((status === "running" || status === "paused") && value.completedAt !== undefined)
  ) {
    return null;
  }
  let sequence = 0;
  const events: GraphEvent[] = [];
  for (const event of value.events) {
    const parsed = parseEvent(event, sequence);
    if (!parsed) return null;
    sequence = parsed.sequence;
    events.push(parsed);
  }
  return { ...(value as EngineeringGraphState), definition, results: results as GraphNodeResult[], events };
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

export function removeEngineeringGraphState(workspace: string, graphId: string): boolean {
  if (!isValidLoopDagId(graphId)) throw new Error(`Graph id must be safe: ${graphId}`);
  const leaseId = `engineering-graph-${graphId}`;
  if (isSessionRunActive(workspace, leaseId)) throw new Error(`Graph is currently running: ${graphId}`);
  const lease = acquireSessionLease(workspace, leaseId);
  try {
    const root = realpathSync.native(workspace);
    const target = join(root, ".seekforge", "graphs", `${graphId}.json`);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (stat === undefined) return false;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync.native(target) !== target ||
      !target.startsWith(`${root}${sep}`)
    ) {
      throw new Error(`Graph checkpoint is not a physical workspace file: ${graphId}`);
    }
    rmSync(target);
    return true;
  } finally {
    lease.release();
  }
}
