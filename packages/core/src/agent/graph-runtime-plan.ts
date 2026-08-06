import type { GraphNode } from "./graph-contract.js";
import { listWorkspaceGraphExecutorReservations } from "./graph-capacity.js";
import { graphExecutionAdapterEligibility, type GraphExecutionAdapter } from "./graph-engineering.js";
import type { EngineeringGraphState } from "./graph-state.js";
import { compareByCodePoints } from "@seekforge/shared";

export type EngineeringGraphRuntimeReplanEntry = {
  nodeId: string;
  status: "ready" | "blocked" | "in_flight" | "deferred";
  score: number;
  reasons: string[];
  executor?: string;
};

export type EngineeringGraphRuntimeReplan = {
  graphId: string;
  fingerprint: string;
  generatedAt: string;
  pending: number;
  recommendedOrder: string[];
  entries: EngineeringGraphRuntimeReplanEntry[];
};

export type WorkspaceExecutorCapacityEntry = {
  executor: string;
  status: ReturnType<typeof graphExecutionAdapterEligibility>["status"];
  capacity: number;
  active: number;
  available: number;
  queueDepth: number;
  utilization: number;
  assignedNodes: number;
};

function deadlineUrgency(node: GraphNode, nowMs: number): number {
  if (!node.deadlineAt) return 0;
  const remaining = Date.parse(node.deadlineAt) - nowMs;
  if (!Number.isFinite(remaining)) return 0;
  if (remaining <= 0) return 10_000;
  return Math.max(0, Math.round(1_000_000 / Math.max(1_000, remaining)));
}

/** Re-evaluates only unfinished nodes; completed/effectful results are immutable inputs. */
export function buildEngineeringGraphRuntimeReplan(
  workspace: string,
  state: EngineeringGraphState,
  executors: Readonly<Record<string, GraphExecutionAdapter>> = {},
  now = new Date(),
): EngineeringGraphRuntimeReplan {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Graph runtime replan time is invalid");
  const completed = new Map(state.results.map((result) => [result.id, result]));
  const active = new Set(state.activeAttempts.map((attempt) => attempt.nodeId));
  const descriptors = Object.getOwnPropertyDescriptors(executors);
  const workspaceActive = new Map<string, number>();
  for (const reservation of listWorkspaceGraphExecutorReservations(workspace, now)) {
    workspaceActive.set(reservation.executor, (workspaceActive.get(reservation.executor) ?? 0) + 1);
  }
  const entries = state.definition.nodes.flatMap((node): EngineeringGraphRuntimeReplanEntry[] => {
    if (completed.has(node.id)) return [];
    if (active.has(node.id)) {
      return [{ nodeId: node.id, status: "in_flight", score: Number.MAX_SAFE_INTEGER, reasons: ["attempt active"] }];
    }
    const missing = (node.dependsOn ?? []).filter((dependency) => !completed.has(dependency));
    const failed = (node.dependsOn ?? []).filter((dependency) => completed.get(dependency)?.status !== "passed");
    const reasons: string[] = [];
    let status: EngineeringGraphRuntimeReplanEntry["status"] = "ready";
    if (missing.length > 0) {
      status = "blocked";
      reasons.push(`waiting for ${missing.join(", ")}`);
    } else if (failed.length > 0 && node.kind !== "join" && !node.condition) {
      status = "blocked";
      reasons.push(`dependency did not pass: ${failed.join(", ")}`);
    }
    let loadPenalty = 0;
    if (node.kind === "remote" && node.executor) {
      const descriptor = descriptors[node.executor];
      const adapter = descriptor && "value" in descriptor ? (descriptor.value as GraphExecutionAdapter) : undefined;
      const eligibility = graphExecutionAdapterEligibility(node, adapter);
      if (status === "ready" && eligibility.status !== "eligible") {
        status = "deferred";
        reasons.push(...eligibility.reasons);
      }
      if (
        status === "ready" &&
        adapter?.workspaceCapacity !== undefined &&
        (workspaceActive.get(node.executor) ?? 0) >= adapter.workspaceCapacity
      ) {
        status = "deferred";
        reasons.push("Workspace executor capacity is exhausted");
      }
      if (adapter) {
        const capacity = adapter.workspaceCapacity ?? adapter.capacity ?? 1;
        const activeCount =
          adapter.workspaceCapacity === undefined ? (adapter.active ?? 0) : (workspaceActive.get(node.executor) ?? 0);
        loadPenalty = Math.round((activeCount / capacity) * 1_000 + (adapter.queueDepth ?? 0));
      }
    }
    const score = (node.priority ?? 0) * 10_000 + deadlineUrgency(node, nowMs) - loadPenalty;
    return [
      {
        nodeId: node.id,
        status,
        score,
        reasons: reasons.length > 0 ? reasons : ["dependencies and runtime eligibility satisfied"],
        ...(node.kind === "remote" && node.executor ? { executor: node.executor } : {}),
      },
    ];
  });
  const recommendedOrder = entries
    .filter((entry) => entry.status === "ready")
    .sort((left, right) => right.score - left.score || compareByCodePoints(left.nodeId, right.nodeId))
    .map((entry) => entry.nodeId);
  return {
    graphId: state.graphId,
    fingerprint: state.fingerprint,
    generatedAt: now.toISOString(),
    pending: entries.length,
    recommendedOrder,
    entries: entries.sort(
      (left, right) =>
        (left.status === "ready" ? 0 : left.status === "in_flight" ? 1 : left.status === "deferred" ? 2 : 3) -
          (right.status === "ready" ? 0 : right.status === "in_flight" ? 1 : right.status === "deferred" ? 2 : 3) ||
        right.score - left.score ||
        compareByCodePoints(left.nodeId, right.nodeId),
    ),
  };
}

/** Summarizes host-owned capacity across every visible Graph definition. */
export function buildWorkspaceExecutorCapacityReport(
  workspace: string,
  states: readonly EngineeringGraphState[],
  executors: Readonly<Record<string, GraphExecutionAdapter>> = {},
): WorkspaceExecutorCapacityEntry[] {
  const reservations = listWorkspaceGraphExecutorReservations(workspace);
  const assignments = new Map<string, number>();
  for (const state of states) {
    for (const node of state.definition.nodes) {
      if (node.kind === "remote" && node.executor)
        assignments.set(node.executor, (assignments.get(node.executor) ?? 0) + 1);
    }
  }
  return Object.entries(Object.getOwnPropertyDescriptors(executors))
    .flatMap(([executor, descriptor]): WorkspaceExecutorCapacityEntry[] => {
      if (!("value" in descriptor) || !descriptor.enumerable || !descriptor.value) return [];
      const adapter = descriptor.value as GraphExecutionAdapter;
      const syntheticNode: GraphNode = { id: "capacity", kind: "remote", executor };
      let status = graphExecutionAdapterEligibility(syntheticNode, adapter).status;
      const workspaceActive = reservations.filter((reservation) => reservation.executor === executor).length;
      const capacity = adapter.workspaceCapacity ?? adapter.capacity ?? 1;
      const active = adapter.workspaceCapacity === undefined ? (adapter.active ?? 0) : workspaceActive;
      if (adapter.workspaceCapacity !== undefined && workspaceActive >= adapter.workspaceCapacity) {
        status = "capacity_exhausted";
      }
      return [
        {
          executor,
          status,
          capacity,
          active,
          available: Math.max(0, capacity - active),
          queueDepth: adapter.queueDepth ?? 0,
          utilization: Math.min(1, Math.max(0, active / capacity)),
          assignedNodes: assignments.get(executor) ?? 0,
        },
      ];
    })
    .sort((left, right) => right.utilization - left.utilization || compareByCodePoints(left.executor, right.executor));
}
