import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray } from "./orchestration.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { acquireSessionLease, SessionBusyError } from "./session-lease.js";

export type EngineeringGraphSignal = {
  id: string;
  name: string;
  payload?: unknown;
  createdAt: string;
  claimedBy?: string;
  claimedAt?: string;
};

const MAX_SIGNAL_BYTES = 256 * 1024;
const MAX_SIGNAL_PAYLOAD_BYTES = 16 * 1024;
const MAX_SIGNALS = 256;

function signalPath(graphId: string): string {
  if (!isValidLoopDagId(graphId)) throw new Error(`Invalid Graph id: ${graphId}`);
  return join(".seekforge", "graphs", `${graphId}.signals.json`);
}

function lockId(graphId: string): string {
  return `graph-signals-${createHash("sha256").update(graphId).digest("hex").slice(0, 32)}`;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function loadSignals(workspace: string, graphId: string): EngineeringGraphSignal[] {
  const raw = readWorkspaceStateFile(workspace, signalPath(graphId), MAX_SIGNAL_BYTES);
  if (raw === undefined) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isDenseArray(value.signals) || value.signals.length > MAX_SIGNALS) {
      throw new Error("shape");
    }
    const ids = new Set<string>();
    return value.signals.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(item.id) ||
        ids.has(item.id) ||
        !isValidLoopDagId(item.name) ||
        !validTimestamp(item.createdAt) ||
        (item.payload !== undefined && Buffer.byteLength(JSON.stringify(item.payload)) > MAX_SIGNAL_PAYLOAD_BYTES) ||
        (item.claimedBy !== undefined && !isValidLoopDagId(item.claimedBy)) ||
        (item.claimedAt !== undefined && !validTimestamp(item.claimedAt)) ||
        (item.claimedBy === undefined) !== (item.claimedAt === undefined)
      ) {
        throw new Error("entry");
      }
      ids.add(item.id);
      return item as EngineeringGraphSignal;
    });
  } catch {
    throw new Error(`Invalid Graph signal mailbox: ${graphId}`);
  }
}

async function withSignalLease<T>(workspace: string, graphId: string, operation: () => T): Promise<T> {
  const deadline = Date.now() + 2_000;
  let lease: ReturnType<typeof acquireSessionLease>;
  for (;;) {
    try {
      lease = acquireSessionLease(workspace, lockId(graphId));
      break;
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out updating Graph signal mailbox: ${graphId}`);
      await delay(10);
    }
  }
  try {
    return operation();
  } finally {
    lease.release();
  }
}

export async function enqueueEngineeringGraphSignal(
  workspace: string,
  graphId: string,
  name: string,
  payload?: unknown,
): Promise<EngineeringGraphSignal> {
  if (!isValidLoopDagId(name)) throw new Error("Graph signal name must be a safe id");
  let payloadBytes = 0;
  try {
    payloadBytes = payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(payload));
  } catch {
    throw new Error("Graph signal payload must be JSON serializable");
  }
  if (payloadBytes > MAX_SIGNAL_PAYLOAD_BYTES) throw new Error("Graph signal payload is too large");
  return withSignalLease(workspace, graphId, () => {
    const signals = loadSignals(workspace, graphId);
    if (signals.length >= MAX_SIGNALS) throw new Error(`Graph signal mailbox is full: ${graphId}`);
    const entry: EngineeringGraphSignal = {
      id: randomUUID(),
      name,
      ...(payload !== undefined ? { payload } : {}),
      createdAt: new Date().toISOString(),
    };
    const serialized = `${JSON.stringify({ version: 1, signals: [...signals, entry] })}\n`;
    if (Buffer.byteLength(serialized) > MAX_SIGNAL_BYTES) throw new Error(`Graph signal mailbox is full: ${graphId}`);
    writeWorkspaceStateFileAtomic(workspace, signalPath(graphId), serialized);
    return entry;
  });
}

export async function claimEngineeringGraphSignal(
  workspace: string,
  graphId: string,
  nodeId: string,
  name: string,
  notAfter?: string,
): Promise<EngineeringGraphSignal | undefined> {
  if (!isValidLoopDagId(nodeId) || !isValidLoopDagId(name) || (notAfter !== undefined && !validTimestamp(notAfter))) {
    throw new Error("Graph signal claim is invalid");
  }
  return withSignalLease(workspace, graphId, () => {
    const signals = loadSignals(workspace, graphId);
    const timely = (entry: EngineeringGraphSignal): boolean =>
      notAfter === undefined || Date.parse(entry.createdAt) <= Date.parse(notAfter);
    const existing = signals.find((entry) => entry.name === name && entry.claimedBy === nodeId && timely(entry));
    if (existing) return existing;
    const available = signals.find((entry) => entry.name === name && entry.claimedBy === undefined && timely(entry));
    if (!available) return undefined;
    // A claim is durable and reusable by the same wait node. This avoids losing
    // an external event if the process exits between mailbox and Graph writes.
    available.claimedBy = nodeId;
    available.claimedAt = new Date().toISOString();
    writeWorkspaceStateFileAtomic(workspace, signalPath(graphId), `${JSON.stringify({ version: 1, signals })}\n`);
    return available;
  });
}

export async function acknowledgeEngineeringGraphSignal(
  workspace: string,
  graphId: string,
  nodeId: string,
  signalId: string,
): Promise<void> {
  if (
    !isValidLoopDagId(nodeId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(signalId)
  ) {
    throw new Error("Graph signal acknowledgement is invalid");
  }
  await withSignalLease(workspace, graphId, () => {
    const signals = loadSignals(workspace, graphId);
    const retained = signals.filter((entry) => entry.id !== signalId || entry.claimedBy !== nodeId);
    if (retained.length === signals.length) return;
    writeWorkspaceStateFileAtomic(
      workspace,
      signalPath(graphId),
      `${JSON.stringify({ version: 1, signals: retained })}\n`,
    );
  });
}
