import type { LoopFailureCategory, LoopIterationSnapshot } from "./auto-loop.js";
import { isRecord } from "../util/guards.js";
import { isDenseArray } from "./orchestration.js";

const LOOP_FAILURE_CATEGORIES = new Set<LoopFailureCategory>([
  "none",
  "test",
  "compile",
  "lint",
  "review",
  "environment",
  "timeout",
  "permission",
  "network",
  "unknown",
]);

export function isLoopFailureCategory(value: unknown): value is LoopFailureCategory {
  return typeof value === "string" && LOOP_FAILURE_CATEGORIES.has(value as LoopFailureCategory);
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

/** Validates the domain model-route contract and returns its unique provider ids. */
export function validateLoopModelRoutes(value: unknown): string[] {
  if (!isRecord(value)) throw new Error("Loop modelRoutesByFailureCategory must be an object");
  if (Object.keys(value).length === 0) {
    throw new Error("Loop modelRoutesByFailureCategory must contain at least one category");
  }
  const models = new Set<string>();
  for (const [category, route] of Object.entries(value)) {
    if (!isLoopFailureCategory(category) || !isDenseArray(route) || route.length === 0 || route.length > 8) {
      throw new Error("Loop modelRoutesByFailureCategory contains an invalid category or model chain");
    }
    if (!route.every(isModelId) || new Set(route).size !== route.length) {
      throw new Error("Loop modelRoutesByFailureCategory contains an invalid category or model chain");
    }
    for (const model of route) models.add(model);
  }
  return [...models];
}

export type LoopModelRouteReason = "default" | "static_category" | "category" | "escalated_category";

export type LoopModelRoute = {
  model?: string;
  category: LoopFailureCategory;
  consecutiveFailures: number;
  candidateIndex: number;
  reason: LoopModelRouteReason;
};

/** Selects only from caller-authorized models; history can change priority, never expand capability. */
export function selectLoopModelRoute(input: {
  category: LoopFailureCategory;
  snapshots: readonly LoopIterationSnapshot[];
  defaultModel?: string;
  staticModel?: string;
  candidates?: readonly string[];
  escalationThreshold: number;
}): LoopModelRoute {
  if (
    !Number.isSafeInteger(input.escalationThreshold) ||
    input.escalationThreshold < 1 ||
    input.escalationThreshold > 8
  ) {
    throw new RangeError("Loop model escalation threshold must be an integer from 1 to 8");
  }
  let consecutiveFailures = 0;
  for (let index = input.snapshots.length - 1; index >= 0; index--) {
    if (input.snapshots[index]?.failureCategory !== input.category || input.category === "none") break;
    consecutiveFailures++;
  }
  if (input.staticModel) {
    return {
      model: input.staticModel,
      category: input.category,
      consecutiveFailures,
      candidateIndex: 0,
      reason: "static_category",
    };
  }
  if (input.candidates?.length) {
    const candidateIndex = Math.min(
      input.candidates.length - 1,
      Math.floor(Math.max(0, consecutiveFailures - 1) / input.escalationThreshold),
    );
    return {
      model: input.candidates[candidateIndex],
      category: input.category,
      consecutiveFailures,
      candidateIndex,
      reason: candidateIndex === 0 ? "category" : "escalated_category",
    };
  }
  return {
    model: input.defaultModel,
    category: input.category,
    consecutiveFailures,
    candidateIndex: 0,
    reason: "default",
  };
}
