import { createHash } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { LoopStageResult } from "./auto-loop.js";
import { isDenseArray } from "./orchestration.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";

const CACHE_PATH = ".seekforge/loop-verification-cache.json";
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_RESULT_OUTPUT_BYTES = 16 * 1024;
const RUNTIME_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }))
  .digest("hex");

type Entry = {
  stageId: string;
  command: string;
  workspaceFingerprint: string;
  runtimeFingerprint: string;
  result: LoopStageResult;
  updatedAt: string;
};

function validEntry(value: unknown, now: number): value is Entry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["stageId", "command", "workspaceFingerprint", "runtimeFingerprint", "result", "updatedAt"]) ||
    !isRecord(value.result) ||
    !hasOnlyKeys(value.result, [
      "id",
      "command",
      "code",
      "output",
      "attempts",
      "flaky",
      "durationMs",
      "selection",
      "matchedPaths",
    ])
  ) {
    return false;
  }
  const updatedAt = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
  return (
    typeof value.stageId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.stageId) &&
    typeof value.command === "string" &&
    value.command.length > 0 &&
    value.command.length <= 8_192 &&
    typeof value.workspaceFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.workspaceFingerprint) &&
    value.runtimeFingerprint === RUNTIME_FINGERPRINT &&
    Number.isFinite(updatedAt) &&
    updatedAt <= now &&
    now - updatedAt <= MAX_AGE_MS &&
    value.result.id === value.stageId &&
    value.result.command === value.command &&
    value.result.code === 0 &&
    typeof value.result.output === "string" &&
    Buffer.byteLength(value.result.output) <= MAX_RESULT_OUTPUT_BYTES &&
    Number.isSafeInteger(value.result.attempts) &&
    (value.result.attempts as number) >= 1 &&
    typeof value.result.flaky === "boolean" &&
    Number.isSafeInteger(value.result.durationMs) &&
    (value.result.durationMs as number) >= 0 &&
    (value.result.selection === undefined ||
      value.result.selection === "full" ||
      value.result.selection === "direct" ||
      value.result.selection === "dependency" ||
      value.result.selection === "cached") &&
    (value.result.matchedPaths === undefined ||
      (isDenseArray(value.result.matchedPaths) &&
        value.result.matchedPaths.length <= 16 &&
        value.result.matchedPaths.every((path) => typeof path === "string" && path.length <= 512)))
  );
}

function boundedOutput(value: string): string {
  if (Buffer.byteLength(value) <= MAX_RESULT_OUTPUT_BYTES) return value;
  let retained = Buffer.from(value).subarray(-MAX_RESULT_OUTPUT_BYTES).toString("utf8");
  while (Buffer.byteLength(retained) > MAX_RESULT_OUTPUT_BYTES) retained = retained.slice(1);
  return retained;
}

function readEntries(workspace: string): Entry[] {
  try {
    const raw = readWorkspaceStateFile(workspace, CACHE_PATH, MAX_CACHE_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "entries"]) ||
      value.version !== 1 ||
      !isDenseArray(value.entries) ||
      value.entries.length > MAX_ENTRIES
    ) {
      return [];
    }
    const now = Date.now();
    return value.entries.filter((entry): entry is Entry => validEntry(entry, now));
  } catch {
    return [];
  }
}

export function readLoopVerificationCache(
  workspace: string,
  stageId: string,
  command: string,
  workspaceFingerprint: string,
): LoopStageResult | undefined {
  return readEntries(workspace).find(
    (entry) =>
      entry.stageId === stageId && entry.command === command && entry.workspaceFingerprint === workspaceFingerprint,
  )?.result;
}

export function recordLoopVerificationCache(
  workspace: string,
  stageId: string,
  command: string,
  workspaceFingerprint: string,
  result: LoopStageResult,
  workspaceGuard?: SessionLease,
): void {
  if (result.code !== 0) return;
  const entry: Entry = {
    stageId,
    command,
    workspaceFingerprint,
    runtimeFingerprint: RUNTIME_FINGERPRINT,
    result: { ...result, output: boundedOutput(result.output) },
    updatedAt: new Date().toISOString(),
  };
  if (!validEntry(entry, Date.now())) throw new Error("Loop verification cache entry is invalid");
  const lease = acquireSessionLease(workspace, "loop-verification-cache", workspaceGuard);
  try {
    const retained = readEntries(workspace).filter(
      (entry) =>
        entry.stageId !== stageId || entry.command !== command || entry.workspaceFingerprint !== workspaceFingerprint,
    );
    writeWorkspaceStateFileAtomic(
      workspace,
      CACHE_PATH,
      `${JSON.stringify({ version: 1, entries: [...retained, entry].slice(-MAX_ENTRIES) })}\n`,
    );
  } finally {
    lease.release();
  }
}
