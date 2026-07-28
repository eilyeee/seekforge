import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { LoopFailureCategory, LoopRecoveryStrategy } from "./auto-loop.js";

export type LoopRecoveryObservation = {
  category: LoopFailureCategory;
  strategy: LoopRecoveryStrategy;
  succeeded: boolean;
  recordedAt: string;
};

const POLICY_PATH = ".seekforge/loop-recovery-policy.json";
const POLICY_BYTES = 128 * 1024;
const MAX_OBSERVATIONS = 128;
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
      !Number.isFinite(Date.parse(item.recordedAt))
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
): LoopRecoveryStrategy {
  const allowed = candidates(category).filter((strategy) => strategy !== avoid);
  if (allowed.length === 0) return defaultLoopRecoveryStrategy(category);
  const observations = readLoopRecoveryObservations(workspace).filter((item) => item.category === category);
  const scored = allowed.map((strategy, index) => {
    const matching = observations.filter((item) => item.strategy === strategy);
    const successes = matching.filter((item) => item.succeeded).length;
    return { strategy, attempts: matching.length, score: (successes + 1) / (matching.length + 2), index };
  });
  const mature = scored.filter((item) => item.attempts >= 2);
  if (mature.length === 0) return allowed[0]!;
  return mature.sort(
    (left, right) => right.score - left.score || right.attempts - left.attempts || left.index - right.index,
  )[0]!.strategy;
}

export function recordLoopRecoveryObservation(workspace: string, observation: LoopRecoveryObservation): void {
  if (
    observation.category === "none" ||
    !CATEGORIES.has(observation.category) ||
    !STRATEGIES.has(observation.strategy) ||
    typeof observation.succeeded !== "boolean" ||
    !Number.isFinite(Date.parse(observation.recordedAt))
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
