import { createHash, randomUUID } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import { buildWorkspaceOrchestrationControlAnalytics } from "./orchestration-control.js";
import { acquireSessionLease } from "./session-lease.js";

export type OrchestrationControllerState = {
  mode: "active" | "frozen";
  reason: string;
  updatedAt: string;
  criticalSince?: string;
};

export type OrchestrationDecision = {
  id: string;
  kind: "graph_preflight" | "graph_schedule" | "loop_route" | "rollout_gate";
  scope: "graph" | "loop" | "workspace";
  sourceId: string;
  policyVersion: number;
  inputFingerprint: string;
  status: "adopted" | "advisory" | "frozen" | "rejected";
  reasons: string[];
  selected: string[];
  decidedAt: string;
  outcome?: "passed" | "failed" | "cancelled" | "superseded";
  completedAt?: string;
};

const CONTROLLER_PATH = ".seekforge/orchestration-controller.json";
const DECISIONS_PATH = ".seekforge/orchestration-decisions.json";
const MAX_BYTES = 512 * 1024;
const MAX_DECISIONS = 512;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,511}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validController(value: unknown): value is OrchestrationControllerState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["mode", "reason", "updatedAt", "criticalSince"]) &&
    (value.mode === "active" || value.mode === "frozen") &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 1_024 &&
    validTimestamp(value.updatedAt) &&
    (value.criticalSince === undefined ||
      (validTimestamp(value.criticalSince) && Date.parse(value.criticalSince) <= Date.parse(value.updatedAt))) &&
    (value.mode === "frozen" ? value.criticalSince !== undefined : value.criticalSince === undefined)
  );
}

function validDecision(value: unknown): value is OrchestrationDecision {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "kind",
      "scope",
      "sourceId",
      "policyVersion",
      "inputFingerprint",
      "status",
      "reasons",
      "selected",
      "decidedAt",
      "outcome",
      "completedAt",
    ]) &&
    typeof value.id === "string" &&
    HASH_RE.test(value.id) &&
    ["graph_preflight", "graph_schedule", "loop_route", "rollout_gate"].includes(String(value.kind)) &&
    ["graph", "loop", "workspace"].includes(String(value.scope)) &&
    typeof value.sourceId === "string" &&
    ID_RE.test(value.sourceId) &&
    Number.isSafeInteger(value.policyVersion) &&
    (value.policyVersion as number) >= 1 &&
    typeof value.inputFingerprint === "string" &&
    HASH_RE.test(value.inputFingerprint) &&
    ["adopted", "advisory", "frozen", "rejected"].includes(String(value.status)) &&
    isDenseArray(value.reasons) &&
    value.reasons.length >= 1 &&
    value.reasons.length <= 16 &&
    value.reasons.every((reason) => typeof reason === "string" && reason.length > 0 && reason.length <= 1_024) &&
    isDenseArray(value.selected) &&
    value.selected.length <= 128 &&
    value.selected.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 512 && !/[\u0000-\u001f\u007f]/.test(item),
    ) &&
    new Set(value.selected).size === value.selected.length &&
    validTimestamp(value.decidedAt) &&
    (value.outcome === undefined || ["passed", "failed", "cancelled", "superseded"].includes(String(value.outcome))) &&
    (value.completedAt === undefined ||
      (validTimestamp(value.completedAt) && Date.parse(value.completedAt) >= Date.parse(value.decidedAt))) &&
    (value.outcome === undefined) === (value.completedAt === undefined)
  );
}

export function fingerprintOrchestrationDecisionInput(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function readOrchestrationControllerState(workspace: string): OrchestrationControllerState {
  const raw = readWorkspaceStateFile(workspace, CONTROLLER_PATH, 16 * 1024);
  if (raw === undefined) {
    return { mode: "active", reason: "No critical SLO burn is active", updatedAt: new Date(0).toISOString() };
  }
  const value = JSON.parse(raw) as unknown;
  if (!validController(value)) throw new Error("Persisted orchestration controller state is invalid");
  return value;
}

function writeController(workspace: string, state: OrchestrationControllerState): OrchestrationControllerState {
  if (!validController(state)) throw new Error("Orchestration controller state is invalid");
  writeWorkspaceStateFileAtomic(workspace, CONTROLLER_PATH, `${JSON.stringify(state)}\n`);
  return state;
}

/** Freezes learned decisions on sustained critical burn; explicit user policy remains authoritative. */
export function reconcileOrchestrationController(
  workspace: string,
  options: { maxBreachRate?: number; minimumSamples?: number; now?: Date } = {},
): OrchestrationControllerState {
  const minimumSamples = options.minimumSamples ?? 3;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 512) {
    throw new RangeError("Orchestration controller minimumSamples must be from 1 to 512");
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Orchestration controller time is invalid");
  const analytics = buildWorkspaceOrchestrationControlAnalytics(workspace, {
    ...(options.maxBreachRate !== undefined ? { maxBreachRate: options.maxBreachRate } : {}),
    now,
  });
  const critical = analytics.burnRates.find(
    (window) => window.status === "critical" && window.samples >= minimumSamples,
  );
  const lease = acquireSessionLease(workspace, "orchestration-controller");
  try {
    const current = readOrchestrationControllerState(workspace);
    if (critical) {
      const updatedAt = nextOrchestrationVersion(current.updatedAt, now.toISOString());
      return writeController(workspace, {
        mode: "frozen",
        reason: `${critical.hours}h SLO burn rate ${critical.burnRate.toFixed(2)} exceeded the critical threshold`,
        updatedAt,
        criticalSince: current.mode === "frozen" ? current.criticalSince : updatedAt,
      });
    }
    if (current.mode === "active") return current;
    return writeController(workspace, {
      mode: "active",
      reason: "SLO burn recovered below the critical threshold",
      updatedAt: nextOrchestrationVersion(current.updatedAt, now.toISOString()),
    });
  } finally {
    lease.release();
  }
}

export function resumeOrchestrationController(
  workspace: string,
  reason = "Manually resumed",
): OrchestrationControllerState {
  if (reason.trim().length === 0 || reason.length > 1_024) throw new Error("Controller resume reason is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-controller");
  try {
    const current = readOrchestrationControllerState(workspace);
    return writeController(workspace, {
      mode: "active",
      reason,
      updatedAt: nextOrchestrationVersion(current.updatedAt),
    });
  } finally {
    lease.release();
  }
}

function readDecisions(workspace: string): OrchestrationDecision[] {
  const raw = readWorkspaceStateFile(workspace, DECISIONS_PATH, MAX_BYTES);
  if (raw === undefined) return [];
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "decisions"]) ||
    value.version !== 1 ||
    !isDenseArray(value.decisions) ||
    value.decisions.length > MAX_DECISIONS ||
    !value.decisions.every(validDecision) ||
    new Set(value.decisions.map((decision) => decision.id)).size !== value.decisions.length
  ) {
    throw new Error("Persisted orchestration decisions are invalid");
  }
  return value.decisions;
}

function writeDecisions(workspace: string, decisions: readonly OrchestrationDecision[]): void {
  const protectedIds = new Set(
    decisions
      .filter((decision) => decision.kind === "graph_preflight" && decision.outcome === undefined)
      .map((decision) => decision.id),
  );
  if (protectedIds.size > MAX_DECISIONS) throw new Error("Too many active orchestration decisions");
  const terminalSlots = MAX_DECISIONS - protectedIds.size;
  const terminalIds =
    terminalSlots === 0
      ? []
      : decisions
          .filter((decision) => !protectedIds.has(decision.id))
          .slice(-terminalSlots)
          .map((decision) => decision.id);
  const retainedIds = new Set([...protectedIds, ...terminalIds]);
  let retained = decisions.filter((decision) => retainedIds.has(decision.id));
  let serialized = `${JSON.stringify({ version: 1, decisions: retained })}\n`;
  while (Buffer.byteLength(serialized) > MAX_BYTES && retained.length > 1) {
    const evict = retained.findIndex((decision) => !protectedIds.has(decision.id));
    if (evict < 0) break;
    retained = retained.filter((_, index) => index !== evict);
    serialized = `${JSON.stringify({ version: 1, decisions: retained })}\n`;
  }
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Orchestration decisions exceed limit");
  writeWorkspaceStateFileAtomic(workspace, DECISIONS_PATH, serialized);
}

export function recordOrchestrationDecision(
  workspace: string,
  input: Omit<OrchestrationDecision, "id" | "decidedAt" | "outcome" | "completedAt">,
): OrchestrationDecision {
  const decidedAt = new Date().toISOString();
  const decision: OrchestrationDecision = {
    ...input,
    id: createHash("sha256").update(`${randomUUID()}\0${input.inputFingerprint}`).digest("hex"),
    decidedAt,
  };
  if (!validDecision(decision)) throw new Error("Orchestration decision is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-decisions");
  try {
    writeDecisions(workspace, [...readDecisions(workspace), decision]);
    return decision;
  } finally {
    lease.release();
  }
}

export function completeOrchestrationDecision(
  workspace: string,
  id: string,
  outcome: NonNullable<OrchestrationDecision["outcome"]>,
): OrchestrationDecision {
  if (!HASH_RE.test(id)) throw new Error("Orchestration decision id is invalid");
  if (!["passed", "failed", "cancelled", "superseded"].includes(outcome)) {
    throw new Error("Orchestration decision outcome is invalid");
  }
  const lease = acquireSessionLease(workspace, "orchestration-decisions");
  try {
    const decisions = readDecisions(workspace);
    const existing = decisions.find((decision) => decision.id === id);
    if (!existing) throw new Error(`Orchestration decision not found: ${id}`);
    if (existing.outcome !== undefined) return existing;
    const completed: OrchestrationDecision = {
      ...existing,
      outcome,
      completedAt: nextOrchestrationVersion(existing.decidedAt),
    };
    if (!validDecision(completed)) throw new Error("Completed orchestration decision is invalid");
    writeDecisions(
      workspace,
      decisions.map((decision) => (decision.id === id ? completed : decision)),
    );
    return completed;
  } finally {
    lease.release();
  }
}

export function listOrchestrationDecisions(workspace: string): OrchestrationDecision[] {
  return readDecisions(workspace).sort(
    (left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt) || left.id.localeCompare(right.id),
  );
}
