import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import type { OrchestrationSloPolicy } from "./orchestration-intelligence.js";
import { isLoopFailureCategory } from "./loop-model-routing.js";
import { acquireSessionLease } from "./session-lease.js";

export type WorkspaceOrchestrationSloPolicy = {
  version: 1;
  policy: OrchestrationSloPolicy;
  evaluationWindow: number;
  maxBreachRate: number;
  updatedAt: string;
};

export type AppliedLoopRoute = {
  loopId: string;
  failureCategory: string;
  model: string;
  proposalId: string;
  appliedAt: string;
};

const SLO_PATH = ".seekforge/orchestration-slo-policy.json";
const ROUTES_PATH = ".seekforge/orchestration-loop-routes.json";
const MAX_BYTES = 64 * 1024;
const MAX_ROUTES = 128;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROPOSAL_RE = /^opt-[a-f0-9]{20}$/;

function finiteRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validSloPolicy(value: unknown): value is OrchestrationSloPolicy {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["maxP95DurationMs", "maxCostUsd", "maxFailureRate", "minForecastCoverage"])
  ) {
    return false;
  }
  return (
    (value.maxP95DurationMs === undefined ||
      (typeof value.maxP95DurationMs === "number" &&
        Number.isFinite(value.maxP95DurationMs) &&
        value.maxP95DurationMs > 0)) &&
    (value.maxCostUsd === undefined ||
      (typeof value.maxCostUsd === "number" && Number.isFinite(value.maxCostUsd) && value.maxCostUsd > 0)) &&
    (value.maxFailureRate === undefined || finiteRate(value.maxFailureRate)) &&
    (value.minForecastCoverage === undefined || finiteRate(value.minForecastCoverage))
  );
}

function parseSloDocument(raw: string): WorkspaceOrchestrationSloPolicy | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "policy", "evaluationWindow", "maxBreachRate", "updatedAt"]) ||
      value.version !== 1 ||
      !validSloPolicy(value.policy) ||
      !Number.isSafeInteger(value.evaluationWindow) ||
      (value.evaluationWindow as number) < 1 ||
      (value.evaluationWindow as number) > 1_000 ||
      !finiteRate(value.maxBreachRate) ||
      typeof value.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(value.updatedAt))
    ) {
      return undefined;
    }
    return value as WorkspaceOrchestrationSloPolicy;
  } catch {
    return undefined;
  }
}

export function readWorkspaceOrchestrationSloPolicy(workspace: string): WorkspaceOrchestrationSloPolicy | undefined {
  const raw = readWorkspaceStateFile(workspace, SLO_PATH, MAX_BYTES);
  return raw === undefined ? undefined : parseSloDocument(raw);
}

export function setWorkspaceOrchestrationSloPolicy(
  workspace: string,
  policy: OrchestrationSloPolicy,
  options: { evaluationWindow?: number; maxBreachRate?: number; expectedUpdatedAt?: string } = {},
): WorkspaceOrchestrationSloPolicy {
  if (!validSloPolicy(policy)) throw new Error("Orchestration SLO policy is invalid");
  if (
    options.evaluationWindow !== undefined &&
    (!Number.isSafeInteger(options.evaluationWindow) ||
      options.evaluationWindow < 1 ||
      options.evaluationWindow > 1_000)
  ) {
    throw new RangeError("Orchestration SLO evaluationWindow must be an integer from 1 to 1000");
  }
  if (options.maxBreachRate !== undefined && !finiteRate(options.maxBreachRate)) {
    throw new RangeError("Orchestration SLO maxBreachRate must be from 0 to 1");
  }
  if (options.expectedUpdatedAt !== undefined && !Number.isFinite(Date.parse(options.expectedUpdatedAt))) {
    throw new Error("Orchestration SLO policy version is invalid");
  }
  const lease = acquireSessionLease(workspace, "orchestration-slo-policy");
  try {
    const raw = readWorkspaceStateFile(workspace, SLO_PATH, MAX_BYTES);
    const current = raw === undefined ? undefined : parseSloDocument(raw);
    if (raw !== undefined && !current) throw new Error("Persisted orchestration SLO policy is invalid");
    if (options.expectedUpdatedAt !== undefined && current?.updatedAt !== options.expectedUpdatedAt) {
      throw new Error("Orchestration SLO policy changed since it was read");
    }
    const evaluationWindow = options.evaluationWindow ?? current?.evaluationWindow ?? 100;
    const maxBreachRate = options.maxBreachRate ?? current?.maxBreachRate ?? 0.05;
    const next: WorkspaceOrchestrationSloPolicy = {
      version: 1,
      policy: { ...(current?.policy ?? {}), ...policy },
      evaluationWindow,
      maxBreachRate,
      updatedAt: current ? nextOrchestrationVersion(current.updatedAt) : new Date().toISOString(),
    };
    writeWorkspaceStateFileAtomic(workspace, SLO_PATH, `${JSON.stringify(next)}\n`);
    return next;
  } finally {
    lease.release();
  }
}

export function isAppliedLoopRoute(value: unknown): value is AppliedLoopRoute {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["loopId", "failureCategory", "model", "proposalId", "appliedAt"]) &&
    typeof value.loopId === "string" &&
    ID_RE.test(value.loopId) &&
    isLoopFailureCategory(value.failureCategory) &&
    typeof value.model === "string" &&
    value.model.trim().length > 0 &&
    value.model.length <= 256 &&
    typeof value.proposalId === "string" &&
    PROPOSAL_RE.test(value.proposalId) &&
    typeof value.appliedAt === "string" &&
    Number.isFinite(Date.parse(value.appliedAt))
  );
}

function readRoutes(workspace: string, strict = false): AppliedLoopRoute[] {
  const raw = readWorkspaceStateFile(workspace, ROUTES_PATH, MAX_BYTES);
  if (raw === undefined) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "routes"]) ||
      value.version !== 1 ||
      !isDenseArray(value.routes) ||
      value.routes.length > MAX_ROUTES ||
      !value.routes.every(isAppliedLoopRoute) ||
      new Set(value.routes.map((route) => `${route.loopId}\0${route.failureCategory}`)).size !== value.routes.length ||
      new Set(value.routes.map((route) => route.proposalId)).size !== value.routes.length
    ) {
      if (strict) throw new Error("Persisted orchestration Loop routes are invalid");
      return [];
    }
    return value.routes;
  } catch (error) {
    if (strict && error instanceof Error && error.message.includes("Persisted orchestration")) throw error;
    if (strict) throw new Error("Persisted orchestration Loop routes are invalid");
    return [];
  }
}

export function readAppliedLoopRoutes(workspace: string, loopId: string): Record<string, string> {
  if (!ID_RE.test(loopId)) return {};
  return Object.fromEntries(
    readRoutes(workspace)
      .filter((route) => route.loopId === loopId)
      .map((route) => [route.failureCategory, route.model]),
  );
}

export function readAppliedLoopRoute(
  workspace: string,
  loopId: string,
  failureCategory: string,
): AppliedLoopRoute | undefined {
  if (!ID_RE.test(loopId) || !ID_RE.test(failureCategory)) return undefined;
  return readRoutes(workspace).find((route) => route.loopId === loopId && route.failureCategory === failureCategory);
}

export function isLoopRoutePolicyApplied(workspace: string, proposalId: string): boolean {
  return PROPOSAL_RE.test(proposalId) && readRoutes(workspace).some((route) => route.proposalId === proposalId);
}

export function applyLoopRoutePolicy(workspace: string, route: AppliedLoopRoute): void {
  if (!isAppliedLoopRoute(route)) throw new Error("Applied Loop route is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-loop-routes");
  try {
    const routes = readRoutes(workspace, true).filter(
      (current) => current.loopId !== route.loopId || current.failureCategory !== route.failureCategory,
    );
    routes.push(route);
    const retained = routes
      .sort((left, right) => Date.parse(left.appliedAt) - Date.parse(right.appliedAt))
      .slice(-MAX_ROUTES);
    writeWorkspaceStateFileAtomic(workspace, ROUTES_PATH, `${JSON.stringify({ version: 1, routes: retained })}\n`);
  } finally {
    lease.release();
  }
}

export function removeLoopRoutePolicy(workspace: string, proposalId: string): void {
  if (!PROPOSAL_RE.test(proposalId)) throw new Error("Orchestration proposal id is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-loop-routes");
  try {
    const current = readRoutes(workspace, true);
    const routes = current.filter((route) => route.proposalId !== proposalId);
    if (routes.length === current.length) return;
    writeWorkspaceStateFileAtomic(workspace, ROUTES_PATH, `${JSON.stringify({ version: 1, routes })}\n`);
  } finally {
    lease.release();
  }
}

/** Atomically removes a deployed route and restores its exact predecessor when present. */
export function rollbackLoopRoutePolicy(workspace: string, proposalId: string, predecessor?: AppliedLoopRoute): void {
  if (!PROPOSAL_RE.test(proposalId) || (predecessor !== undefined && !isAppliedLoopRoute(predecessor))) {
    throw new Error("Orchestration Loop route rollback is invalid");
  }
  const lease = acquireSessionLease(workspace, "orchestration-loop-routes");
  try {
    const current = readRoutes(workspace, true);
    const deployed = current.find((route) => route.proposalId === proposalId);
    if (!deployed) throw new Error("Applied Loop route is missing during rollback");
    const routes = current.filter(
      (route) =>
        route.proposalId !== proposalId &&
        (predecessor === undefined ||
          route.loopId !== predecessor.loopId ||
          route.failureCategory !== predecessor.failureCategory),
    );
    if (predecessor) routes.push(predecessor);
    writeWorkspaceStateFileAtomic(workspace, ROUTES_PATH, `${JSON.stringify({ version: 1, routes })}\n`);
  } finally {
    lease.release();
  }
}
