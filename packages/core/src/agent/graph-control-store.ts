import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { loadEngineeringGraphState } from "./graph-state.js";
import { acquireSessionLease, SessionBusyError } from "./session-lease.js";

export type DurableGraphControlCommand =
  | { operation: "pause" }
  | { operation: "resume" }
  | { operation: "steer"; message: string };

export type DurableGraphControlEntry = DurableGraphControlCommand & { seq: number; runId: string; ts: string };

const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_CONTROL_ENTRIES = 256;
const MAX_STEER_LENGTH = 4_000;

function controlPath(graphId: string): string {
  if (!isValidLoopDagId(graphId)) throw new Error(`Invalid Graph id: ${graphId}`);
  return join(".seekforge", "graphs", `${graphId}.control.json`);
}

function lockId(graphId: string): string {
  return `graph-control-${createHash("sha256").update(graphId).digest("hex").slice(0, 32)}`;
}

function loadEntries(workspace: string, graphId: string): DurableGraphControlEntry[] {
  const raw = readWorkspaceStateFile(workspace, controlPath(graphId), MAX_CONTROL_BYTES);
  if (raw === undefined) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 256) {
      throw new Error("shape");
    }
    let previous = 0;
    return value.entries.map((item) => {
      if (
        !isRecord(item) ||
        !Number.isSafeInteger(item.seq) ||
        (item.seq as number) <= previous ||
        !isValidLoopDagId(item.runId) ||
        typeof item.ts !== "string" ||
        !Number.isFinite(Date.parse(item.ts)) ||
        (item.operation !== "pause" && item.operation !== "resume" && item.operation !== "steer") ||
        (item.operation === "steer" &&
          (typeof item.message !== "string" || item.message.trim() === "" || item.message.length > MAX_STEER_LENGTH))
      ) {
        throw new Error("entry");
      }
      previous = item.seq as number;
      return item as DurableGraphControlEntry;
    });
  } catch {
    throw new Error(`Invalid Graph control mailbox: ${graphId}`);
  }
}

export function readGraphControlEntries(
  workspace: string,
  graphId: string,
  runId: string,
  afterSeq = 0,
): DurableGraphControlEntry[] {
  if (!isValidLoopDagId(runId)) throw new Error(`Invalid Graph control run id: ${runId}`);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be non-negative");
  return loadEntries(workspace, graphId).filter((entry) => entry.runId === runId && entry.seq > afterSeq);
}

export async function enqueueGraphControl(
  workspace: string,
  graphId: string,
  runId: string,
  command: DurableGraphControlCommand,
): Promise<DurableGraphControlEntry> {
  if (!isValidLoopDagId(runId)) throw new Error(`Invalid Graph control run id: ${runId}`);
  if (
    !isRecord(command) ||
    (command.operation !== "pause" && command.operation !== "resume" && command.operation !== "steer") ||
    (command.operation === "steer" && typeof command.message !== "string")
  ) {
    throw new Error("Invalid Graph control command");
  }
  const normalized: DurableGraphControlCommand =
    command.operation === "steer"
      ? { operation: "steer", message: command.message.trim().slice(0, MAX_STEER_LENGTH) }
      : { operation: command.operation };
  if (normalized.operation === "steer" && normalized.message === "")
    throw new Error("Graph guidance must be non-empty");
  let lease: ReturnType<typeof acquireSessionLease>;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      lease = acquireSessionLease(workspace, lockId(graphId));
      break;
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out updating Graph control mailbox: ${graphId}`);
      await delay(10);
    }
  }
  try {
    const entries = loadEntries(workspace, graphId);
    const previousSeq = entries.at(-1)?.seq ?? 0;
    if (previousSeq >= Number.MAX_SAFE_INTEGER) throw new Error(`Graph control sequence is exhausted: ${graphId}`);
    const state = loadEngineeringGraphState(workspace, graphId);
    if (state?.status !== "running" || state.controlRunId !== runId) {
      throw new Error(`Graph control run is not active: ${graphId}`);
    }
    const consumed = state.controlSeq;
    const pending = entries.filter((entry) => entry.runId === runId && entry.seq > consumed);
    if (pending.length >= MAX_CONTROL_ENTRIES) throw new Error(`Graph control mailbox is full: ${graphId}`);
    const entry: DurableGraphControlEntry = {
      ...normalized,
      seq: previousSeq + 1,
      runId,
      ts: new Date().toISOString(),
    };
    const payload = `${JSON.stringify({ version: 1, entries: [...pending, entry] })}\n`;
    if (Buffer.byteLength(payload) > MAX_CONTROL_BYTES) throw new Error(`Graph control mailbox is full: ${graphId}`);
    writeWorkspaceStateFileAtomic(workspace, controlPath(graphId), payload);
    return entry;
  } finally {
    lease.release();
  }
}
