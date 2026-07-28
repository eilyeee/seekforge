import { createHash } from "node:crypto";
import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";

export type LoopBudgetObservation = {
  key: string;
  costUsd: number;
  tokens: number;
  durationMs: number;
  passed: boolean;
  recordedAt: string;
};

export type LoopBudgetPrediction = {
  weight: number;
  samples: number;
  expectedCostUsd: number;
  expectedTokens: number;
  expectedDurationMs: number;
};

const HISTORY_PATH = ".seekforge/loop-budget-history.json";
const MAX_BYTES = 128 * 1024;
const MAX_OBSERVATIONS = 256;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/;

export function loopBudgetObservationKey(nodeId: string, verifyCommand: string): string {
  const key = `${nodeId}:${createHash("sha256").update(verifyCommand).digest("hex").slice(0, 16)}`;
  if (!KEY_RE.test(key)) throw new Error("Loop budget observation key is invalid");
  return key;
}

export function readLoopBudgetHistory(workspace: string): LoopBudgetObservation[] {
  let raw: string | undefined;
  try {
    raw = readWorkspaceStateFile(workspace, HISTORY_PATH, MAX_BYTES);
  } catch {
    return [];
  }
  if (raw === undefined) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.observations)) return [];
  return value.observations.slice(-MAX_OBSERVATIONS).flatMap((item): LoopBudgetObservation[] => {
    if (
      !isRecord(item) ||
      typeof item.key !== "string" ||
      !KEY_RE.test(item.key) ||
      typeof item.costUsd !== "number" ||
      !Number.isFinite(item.costUsd) ||
      item.costUsd < 0 ||
      !Number.isSafeInteger(item.tokens) ||
      (item.tokens as number) < 0 ||
      !Number.isSafeInteger(item.durationMs) ||
      (item.durationMs as number) < 0 ||
      typeof item.passed !== "boolean" ||
      typeof item.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(item.recordedAt))
    ) {
      return [];
    }
    return [item as LoopBudgetObservation];
  });
}

export function predictLoopBudgetWeight(workspace: string, key: string, baseWeight = 1): LoopBudgetPrediction {
  if (!KEY_RE.test(key) || !Number.isFinite(baseWeight) || baseWeight <= 0) {
    throw new Error("Loop budget prediction input is invalid");
  }
  const samples = readLoopBudgetHistory(workspace)
    .filter((item) => item.key === key)
    .slice(-16);
  if (samples.length === 0) {
    return { weight: baseWeight, samples: 0, expectedCostUsd: 0, expectedTokens: 0, expectedDurationMs: 0 };
  }
  let cost = 0;
  let tokens = 0;
  let duration = 0;
  let failures = 0;
  let totalWeight = 0;
  for (const [index, item] of samples.entries()) {
    const recency = index + 1;
    totalWeight += recency;
    cost += item.costUsd * recency;
    tokens += item.tokens * recency;
    duration += item.durationMs * recency;
    if (!item.passed) failures += recency;
  }
  const expectedCostUsd = cost / totalWeight;
  const expectedTokens = tokens / totalWeight;
  const expectedDurationMs = duration / totalWeight;
  const demand = 1 + Math.min(2, expectedCostUsd * 2 + expectedTokens / 100_000 + expectedDurationMs / 600_000);
  const failureFactor = 1 + Math.min(1, failures / totalWeight);
  return {
    weight: Math.max(0.25, Math.min(4, baseWeight * demand * failureFactor)),
    samples: samples.length,
    expectedCostUsd,
    expectedTokens,
    expectedDurationMs,
  };
}

export function recordLoopBudgetObservation(workspace: string, observation: LoopBudgetObservation): void {
  if (
    !KEY_RE.test(observation.key) ||
    !Number.isFinite(observation.costUsd) ||
    observation.costUsd < 0 ||
    !Number.isSafeInteger(observation.tokens) ||
    observation.tokens < 0 ||
    !Number.isSafeInteger(observation.durationMs) ||
    observation.durationMs < 0 ||
    typeof observation.passed !== "boolean" ||
    !Number.isFinite(Date.parse(observation.recordedAt))
  ) {
    throw new Error("Loop budget observation is invalid");
  }
  const observations = [...readLoopBudgetHistory(workspace), observation].slice(-MAX_OBSERVATIONS);
  writeWorkspaceStateFileAtomic(
    workspace,
    HISTORY_PATH,
    `${JSON.stringify({ schemaVersion: 1, observations }, null, 2)}\n`,
  );
}
