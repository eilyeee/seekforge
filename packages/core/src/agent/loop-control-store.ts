import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { acquireSessionLease, SessionBusyError } from "./session-lease.js";
import { isValidLoopId, loadLoopState } from "./loop-state.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isRecord } from "../util/guards.js";

export type DurableLoopControlCommand =
  | { operation: "pause" }
  | { operation: "resume" }
  | { operation: "steer"; message: string };

export type DurableLoopControlEntry = DurableLoopControlCommand & { seq: number; runId: string; ts: string };

const MAX_CONTROL_BYTES = 256 * 1024;
const MAX_CONTROL_ENTRIES = 256;
const MAX_STEER_LENGTH = 4_000;

function controlPath(loopId: string): string {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  return join(".seekforge", "loops", `${loopId}.control.json`);
}

function lockId(loopId: string): string {
  return `loop-control-${createHash("sha256").update(loopId).digest("hex").slice(0, 32)}`;
}

function parseEntries(value: unknown): DurableLoopControlEntry[] | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_CONTROL_ENTRIES
  )
    return null;
  const entries: DurableLoopControlEntry[] = [];
  let previous = 0;
  for (const item of value.entries) {
    if (
      !isRecord(item) ||
      !Number.isSafeInteger(item.seq) ||
      (item.seq as number) <= previous ||
      typeof item.runId !== "string" ||
      !isValidLoopId(item.runId) ||
      typeof item.ts !== "string" ||
      !Number.isFinite(Date.parse(item.ts)) ||
      (item.operation !== "pause" && item.operation !== "resume" && item.operation !== "steer") ||
      (item.operation === "steer" &&
        (typeof item.message !== "string" || item.message.trim() === "" || item.message.length > MAX_STEER_LENGTH))
    ) {
      return null;
    }
    previous = item.seq as number;
    entries.push(item as DurableLoopControlEntry);
  }
  return entries;
}

function loadEntries(workspace: string, loopId: string): DurableLoopControlEntry[] {
  const raw = readWorkspaceStateFile(workspace, controlPath(loopId), MAX_CONTROL_BYTES);
  if (raw === undefined) return [];
  try {
    const parsed = parseEntries(JSON.parse(raw) as unknown);
    if (parsed !== null) return parsed;
  } catch {
    // Convert syntax errors into the same stable corruption error as shape errors.
  }
  throw new Error(`Invalid Loop control mailbox: ${loopId}`);
}

export function readLoopControlEntries(
  workspace: string,
  loopId: string,
  runId: string,
  afterSeq = 0,
): DurableLoopControlEntry[] {
  if (!isValidLoopId(runId)) throw new Error(`Invalid loop control run id: ${runId}`);
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new RangeError("afterSeq must be a non-negative integer");
  return loadEntries(workspace, loopId).filter((entry) => entry.runId === runId && entry.seq > afterSeq);
}

export async function enqueueLoopControl(
  workspace: string,
  loopId: string,
  runId: string,
  command: DurableLoopControlCommand,
): Promise<DurableLoopControlEntry> {
  if (!isValidLoopId(runId)) throw new Error(`Invalid loop control run id: ${runId}`);
  const normalized: DurableLoopControlCommand =
    command.operation === "steer"
      ? { operation: "steer", message: command.message.trim().slice(0, MAX_STEER_LENGTH) }
      : command;
  if (normalized.operation === "steer" && normalized.message === "") throw new Error("Loop guidance must be non-empty");
  let lease: ReturnType<typeof acquireSessionLease>;
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      lease = acquireSessionLease(workspace, lockId(loopId));
      break;
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out updating Loop control mailbox: ${loopId}`);
      await delay(10);
    }
  }
  try {
    const entries = loadEntries(workspace, loopId);
    const previousSeq = entries.at(-1)?.seq ?? 0;
    if (previousSeq >= Number.MAX_SAFE_INTEGER) throw new Error(`Loop control sequence is exhausted: ${loopId}`);
    const consumedSeq = loadLoopState(workspace, loopId)?.controlSeq ?? 0;
    const pending = entries.filter((entry) => entry.runId === runId && entry.seq > consumedSeq);
    if (pending.length >= MAX_CONTROL_ENTRIES) throw new Error(`Loop control mailbox is full: ${loopId}`);
    const entry: DurableLoopControlEntry = {
      ...normalized,
      seq: previousSeq + 1,
      runId,
      ts: new Date().toISOString(),
    };
    const retained = [...pending, entry];
    const payload = `${JSON.stringify({ version: 1, entries: retained })}\n`;
    if (Buffer.byteLength(payload) > MAX_CONTROL_BYTES) throw new Error(`Loop control mailbox is full: ${loopId}`);
    writeWorkspaceStateFileAtomic(workspace, controlPath(loopId), payload);
    return entry;
  } finally {
    lease.release();
  }
}
