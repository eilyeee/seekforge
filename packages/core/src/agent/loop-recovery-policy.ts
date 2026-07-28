import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { LoopFailureCategory, LoopRecoveryStrategy } from "./auto-loop.js";

export type LoopRecoveryObservation = {
  category: LoopFailureCategory;
  strategy: LoopRecoveryStrategy;
  succeeded: boolean;
  recordedAt: string;
  context?: LoopRecoveryContext;
  costUsd?: number;
  durationMs?: number;
  diagnosticDelta?: number;
};

export type LoopRecoveryContext = { framework?: string; stageId?: string };
export type LoopRecoveryDecision = {
  strategy: LoopRecoveryStrategy;
  confidence: number;
  samples: number;
  expectedUtility: number;
  reason: string;
};

const POLICY_PATH = ".seekforge/loop-recovery-policy.json";
const POLICY_BYTES = 128 * 1024;
const MAX_OBSERVATIONS = 128;
const CONTEXT_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1_000;
const CATEGORIES = new Set<LoopFailureCategory>([
  "none",
  "test",
  "compile",
  "lint",
  "environment",
  "timeout",
  "permission",
  "network",
  "unknown",
]);
const STRATEGIES = new Set<LoopRecoveryStrategy>([
  "isolate_test",
  "repair_compile",
  "repair_lint",
  "validate_environment",
  "reduce_scope",
  "replan",
]);

function candidates(category: LoopFailureCategory): LoopRecoveryStrategy[] {
  if (category === "test") return ["isolate_test", "replan"];
  if (category === "compile") return ["repair_compile", "replan"];
  if (category === "lint") return ["repair_lint", "replan"];
  if (category === "environment" || category === "permission" || category === "network") {
    return ["validate_environment", "replan"];
  }
  if (category === "timeout") return ["reduce_scope", "replan"];
  return ["replan"];
}

function validContext(value: unknown): value is LoopRecoveryContext {
  return (
    isRecord(value) &&
    (value.framework === undefined || (typeof value.framework === "string" && CONTEXT_RE.test(value.framework))) &&
    (value.stageId === undefined || (typeof value.stageId === "string" && CONTEXT_RE.test(value.stageId)))
  );
}

export function defaultLoopRecoveryStrategy(category: LoopFailureCategory): LoopRecoveryStrategy {
  return candidates(category)[0]!;
}

export function readLoopRecoveryObservations(workspace: string): LoopRecoveryObservation[] {
  let raw: string | undefined;
  try {
    raw = readWorkspaceStateFile(workspace, POLICY_PATH, POLICY_BYTES);
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
  return value.observations.slice(-MAX_OBSERVATIONS).flatMap((item): LoopRecoveryObservation[] => {
    if (
      !isRecord(item) ||
      typeof item.category !== "string" ||
      !CATEGORIES.has(item.category as LoopFailureCategory) ||
      item.category === "none" ||
      typeof item.strategy !== "string" ||
      !STRATEGIES.has(item.strategy as LoopRecoveryStrategy) ||
      typeof item.succeeded !== "boolean" ||
      typeof item.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(item.recordedAt)) ||
      (item.context !== undefined && !validContext(item.context)) ||
      (item.costUsd !== undefined &&
        (typeof item.costUsd !== "number" || !Number.isFinite(item.costUsd) || item.costUsd < 0)) ||
      (item.durationMs !== undefined && (!Number.isSafeInteger(item.durationMs) || (item.durationMs as number) < 0)) ||
      (item.diagnosticDelta !== undefined &&
        (!Number.isSafeInteger(item.diagnosticDelta) || Math.abs(item.diagnosticDelta as number) > 1_000_000))
    ) {
      return [];
    }
    return [item as LoopRecoveryObservation];
  });
}

/**
 * Chooses only from category-safe strategies. Historical outcomes become
 * authoritative after two samples; sparse data retains the deterministic
 * default and never affects permissions or budgets.
 */
export function selectLoopRecoveryStrategy(
  workspace: string,
  category: LoopFailureCategory,
  avoid?: LoopRecoveryStrategy,
  context?: LoopRecoveryContext,
): LoopRecoveryStrategy {
  return explainLoopRecoveryStrategy(workspace, category, { avoid, context }).strategy;
}

export function explainLoopRecoveryStrategy(
  workspace: string,
  category: LoopFailureCategory,
  options: { avoid?: LoopRecoveryStrategy; context?: LoopRecoveryContext; now?: Date } = {},
): LoopRecoveryDecision {
  if (options.context !== undefined && !validContext(options.context)) {
    throw new Error("Loop recovery context is invalid");
  }
  const allowed = candidates(category).filter((strategy) => strategy !== options.avoid);
  if (allowed.length === 0) {
    const strategy = defaultLoopRecoveryStrategy(category);
    return { strategy, confidence: 0, samples: 0, expectedUtility: 0.5, reason: "only category-safe strategy" };
  }
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Loop recovery decision time is invalid");
  const observations = readLoopRecoveryObservations(workspace).filter((item) => item.category === category);
  const scored = allowed.map((strategy, index) => {
    const matching = observations.filter((item) => item.strategy === strategy);
    let weightedUtility = 1;
    let weight = 2;
    let evidenceWeight = 0;
    for (const item of matching) {
      const age = Math.max(0, nowMs - Date.parse(item.recordedAt));
      let itemWeight = 0.5 ** (age / HALF_LIFE_MS);
      if (options.context?.framework && item.context?.framework === options.context.framework) itemWeight *= 1.5;
      if (options.context?.stageId && item.context?.stageId === options.context.stageId) itemWeight *= 2;
      evidenceWeight += itemWeight;
      const progress = item.succeeded ? 1 : 0;
      const diagnosticBonus = Math.max(-0.2, Math.min(0.2, (item.diagnosticDelta ?? 0) / 10));
      const costPenalty = Math.min(0.2, (item.costUsd ?? 0) / 5);
      const durationPenalty = Math.min(0.1, (item.durationMs ?? 0) / 3_600_000);
      weightedUtility += itemWeight * (progress + diagnosticBonus - costPenalty - durationPenalty);
      weight += itemWeight;
    }
    return { strategy, attempts: matching.length, evidenceWeight, score: weightedUtility / weight, index };
  });
  const mature = scored
    .filter((item) => item.attempts >= 2 && item.evidenceWeight >= 0.5)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.evidenceWeight - left.evidenceWeight ||
        right.attempts - left.attempts ||
        left.index - right.index,
    );
  const selected = mature[0] ?? scored[0]!;
  const runnerUp = (mature[1] ?? scored.find((item) => item.strategy !== selected.strategy))?.score ?? 0.5;
  const confidence = Math.max(0, Math.min(1, (selected.evidenceWeight / 3) * Math.abs(selected.score - runnerUp) * 2));
  return {
    strategy: selected.strategy,
    confidence,
    samples: selected.attempts,
    expectedUtility: selected.score,
    reason:
      selected.attempts < 2 || selected.evidenceWeight < 0.5
        ? "deterministic category default; contextual evidence is still sparse"
        : `recency- and context-weighted utility from ${selected.attempts} observation(s)`,
  };
}

export function recordLoopRecoveryObservation(workspace: string, observation: LoopRecoveryObservation): void {
  if (
    observation.category === "none" ||
    !CATEGORIES.has(observation.category) ||
    !STRATEGIES.has(observation.strategy) ||
    typeof observation.succeeded !== "boolean" ||
    !Number.isFinite(Date.parse(observation.recordedAt)) ||
    (observation.context !== undefined && !validContext(observation.context)) ||
    (observation.costUsd !== undefined && (!Number.isFinite(observation.costUsd) || observation.costUsd < 0)) ||
    (observation.durationMs !== undefined &&
      (!Number.isSafeInteger(observation.durationMs) || observation.durationMs < 0)) ||
    (observation.diagnosticDelta !== undefined &&
      (!Number.isSafeInteger(observation.diagnosticDelta) || Math.abs(observation.diagnosticDelta) > 1_000_000))
  ) {
    throw new Error("Loop recovery observation is invalid");
  }
  const observations = [...readLoopRecoveryObservations(workspace), observation].slice(-MAX_OBSERVATIONS);
  writeWorkspaceStateFileAtomic(
    workspace,
    POLICY_PATH,
    `${JSON.stringify({ schemaVersion: 1, observations }, null, 2)}\n`,
  );
}
