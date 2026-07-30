import { createHash } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { serializeNewestJsonArray } from "../util/bounded-json.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { LoopFailureCategory, LoopStageResult } from "./auto-loop.js";
import { isLoopFailureCategory } from "./loop-model-routing.js";
import { isDenseArray } from "./orchestration.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";

const INTELLIGENCE_PATH = ".seekforge/loop-verification-intelligence.json";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ENTRIES = 128;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_SAMPLES = 10_000;
const RUNTIME_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }))
  .digest("hex");

export type LoopVerificationIntelligence = {
  stageId: string;
  command: string;
  runtimeFingerprint: string;
  samples: number;
  passes: number;
  failures: number;
  flakyRuns: number;
  consecutiveFailures: number;
  averageDurationMs: number;
  lastCode: number;
  lastFailureCategory: LoopFailureCategory;
  updatedAt: string;
};

export type LoopVerificationIntelligenceFinding = {
  stageId: string;
  kind: "failure_streak" | "failure_rate" | "flaky";
  severity: "warning" | "critical";
  message: string;
};

export type LoopVerificationReliability = {
  stageId: string;
  confidence: "low" | "medium" | "high";
  failureRate: number;
  flakyRate: number;
  ageWeight: number;
  /** Advisory retry count. Required verification stages are never skipped. */
  recommendedAttempts: 1 | 2 | 3;
  quarantineCandidate: boolean;
};

/** Derives confidence-aware advice without weakening authoritative verification. */
export function summarizeLoopVerificationReliability(
  entry: LoopVerificationIntelligence,
  now = Date.now(),
): LoopVerificationReliability {
  const updatedAt = Date.parse(entry.updatedAt);
  const ageMs = Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : MAX_AGE_MS;
  const ageWeight = Math.max(0, 1 - ageMs / MAX_AGE_MS);
  const confidence =
    entry.samples >= 12 && ageWeight >= 0.75 ? "high" : entry.samples >= 4 && ageWeight >= 0.25 ? "medium" : "low";
  const failureRate = entry.failures / entry.samples;
  const flakyRate = entry.flakyRuns / entry.samples;
  const advisoryFlakyRate = flakyRate * ageWeight;
  return {
    stageId: entry.stageId,
    confidence,
    failureRate,
    flakyRate,
    ageWeight,
    recommendedAttempts: confidence === "low" ? 1 : advisoryFlakyRate >= 0.5 ? 3 : advisoryFlakyRate >= 0.2 ? 2 : 1,
    quarantineCandidate:
      confidence !== "low" && entry.samples >= 8 && ageWeight >= 0.5 && flakyRate >= 0.5 && failureRate < 0.5,
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function serializeEntries(entries: readonly LoopVerificationIntelligence[]): string {
  return serializeNewestJsonArray(entries, {
    maxItems: MAX_ENTRIES,
    maxBytes: MAX_FILE_BYTES,
    envelope: (retained) => ({ version: 1, entries: retained }),
    overflowMessage: "Loop verification intelligence entry exceeds the durable byte limit",
  }).serialized;
}

function validEntry(value: unknown, now: number): value is LoopVerificationIntelligence {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "stageId",
      "command",
      "runtimeFingerprint",
      "samples",
      "passes",
      "failures",
      "flakyRuns",
      "consecutiveFailures",
      "averageDurationMs",
      "lastCode",
      "lastFailureCategory",
      "updatedAt",
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
    value.runtimeFingerprint === RUNTIME_FINGERPRINT &&
    isSafeInteger(value.samples) &&
    value.samples >= 1 &&
    value.samples <= MAX_SAMPLES &&
    isSafeInteger(value.passes) &&
    value.passes >= 0 &&
    isSafeInteger(value.failures) &&
    value.failures >= 0 &&
    value.passes + value.failures === value.samples &&
    isSafeInteger(value.flakyRuns) &&
    value.flakyRuns >= 0 &&
    value.flakyRuns <= value.samples &&
    isSafeInteger(value.consecutiveFailures) &&
    value.consecutiveFailures >= 0 &&
    value.consecutiveFailures <= value.failures &&
    isSafeInteger(value.averageDurationMs) &&
    value.averageDurationMs >= 0 &&
    isSafeInteger(value.lastCode) &&
    isLoopFailureCategory(value.lastFailureCategory) &&
    (value.lastCode === 0) === (value.lastFailureCategory === "none") &&
    Number.isFinite(updatedAt) &&
    updatedAt <= now &&
    now - updatedAt <= MAX_AGE_MS
  );
}

export function readLoopVerificationIntelligence(workspace: string): LoopVerificationIntelligence[] {
  try {
    const raw = readWorkspaceStateFile(workspace, INTELLIGENCE_PATH, MAX_FILE_BYTES);
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
    return value.entries.filter((entry): entry is LoopVerificationIntelligence => validEntry(entry, now));
  } catch {
    return [];
  }
}

export function recordLoopVerificationIntelligence(
  workspace: string,
  result: LoopStageResult,
  failureCategory: LoopFailureCategory,
  workspaceGuard?: SessionLease,
): LoopVerificationIntelligence {
  if (
    typeof result.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result.id) ||
    typeof result.command !== "string" ||
    result.command.length === 0 ||
    result.command.length > 8_192 ||
    !Number.isSafeInteger(result.code) ||
    !Number.isSafeInteger(result.attempts) ||
    result.attempts < 1 ||
    !Number.isSafeInteger(result.durationMs) ||
    result.durationMs < 0 ||
    typeof result.flaky !== "boolean" ||
    (result.flaky && (result.code !== 0 || result.attempts < 2)) ||
    !isLoopFailureCategory(failureCategory) ||
    (result.code === 0) !== (failureCategory === "none")
  ) {
    throw new Error("Loop verification intelligence observation is invalid");
  }
  const lease = acquireSessionLease(workspace, "loop-verification-intelligence", workspaceGuard);
  try {
    // Read after acquiring the lease so concurrent recorders cannot overwrite a
    // newer aggregate with a snapshot taken while waiting for ownership.
    const entries = readLoopVerificationIntelligence(workspace);
    const previous = entries.find((entry) => entry.stageId === result.id && entry.command === result.command);
    const previousSamples = previous?.samples ?? 0;
    const retainedSamples = previousSamples >= MAX_SAMPLES ? Math.floor(previousSamples / 2) : previousSamples;
    const retainedPasses = previous
      ? Math.min(retainedSamples, Math.round((previous.passes / previous.samples) * retainedSamples))
      : 0;
    const retainedFailures = retainedSamples - retainedPasses;
    const retainedFlakyRuns = previous
      ? Math.min(retainedSamples, Math.round((previous.flakyRuns / previous.samples) * retainedSamples))
      : 0;
    const samples = retainedSamples + 1;
    const passed = result.code === 0;
    const failures = retainedFailures + (passed ? 0 : 1);
    const entry: LoopVerificationIntelligence = {
      stageId: result.id,
      command: result.command,
      runtimeFingerprint: RUNTIME_FINGERPRINT,
      samples,
      passes: retainedPasses + (passed ? 1 : 0),
      failures,
      flakyRuns: Math.min(samples, retainedFlakyRuns + (result.flaky ? 1 : 0)),
      consecutiveFailures: passed ? 0 : Math.min(failures, (previous?.consecutiveFailures ?? 0) + 1),
      averageDurationMs: Math.round(
        previous
          ? previous.averageDurationMs + (result.durationMs - previous.averageDurationMs) / samples
          : result.durationMs,
      ),
      lastCode: result.code,
      lastFailureCategory: passed ? "none" : failureCategory,
      updatedAt: new Date().toISOString(),
    };
    if (!validEntry(entry, Date.now())) throw new Error("Loop verification intelligence entry is invalid");
    const retained = entries.filter(
      (candidate) => candidate.stageId !== result.id || candidate.command !== result.command,
    );
    writeWorkspaceStateFileAtomic(workspace, INTELLIGENCE_PATH, serializeEntries([...retained, entry]));
    return entry;
  } finally {
    lease.release();
  }
}

/** Higher scores run earlier within a safe ready wave; this never changes dependencies or resources. */
export function loopVerificationIntelligenceScore(entry: LoopVerificationIntelligence | undefined): number {
  if (!entry) return 0;
  const reliability = summarizeLoopVerificationReliability(entry);
  const failureRate = reliability.failureRate * reliability.ageWeight;
  const flakyRate = reliability.flakyRate * reliability.ageWeight;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    entry.consecutiveFailures * reliability.ageWeight * 10_000_000 +
      failureRate * 1_000_000 +
      flakyRate * 100_000 +
      entry.averageDurationMs,
  );
}

export function analyzeLoopVerificationIntelligence(
  entries: readonly LoopVerificationIntelligence[],
): LoopVerificationIntelligenceFinding[] {
  const findings: LoopVerificationIntelligenceFinding[] = [];
  for (const entry of entries) {
    if (entry.consecutiveFailures >= 2) {
      findings.push({
        stageId: entry.stageId,
        kind: "failure_streak",
        severity: entry.consecutiveFailures >= 4 ? "critical" : "warning",
        message: `${entry.stageId} has failed ${entry.consecutiveFailures} consecutive authoritative runs`,
      });
    }
    if (entry.samples >= 4 && entry.failures / entry.samples >= 0.5) {
      findings.push({
        stageId: entry.stageId,
        kind: "failure_rate",
        severity: entry.failures / entry.samples >= 0.75 ? "critical" : "warning",
        message: `${entry.stageId} fails ${Math.round((entry.failures / entry.samples) * 100)}% of recent runs`,
      });
    }
    if (entry.samples >= 4 && entry.flakyRuns / entry.samples >= 0.25) {
      findings.push({
        stageId: entry.stageId,
        kind: "flaky",
        severity: entry.flakyRuns / entry.samples >= 0.5 ? "critical" : "warning",
        message: `${entry.stageId} is flaky in ${Math.round((entry.flakyRuns / entry.samples) * 100)}% of recent runs`,
      });
    }
  }
  return findings;
}
