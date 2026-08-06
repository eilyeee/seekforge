import { isDeepStrictEqual } from "node:util";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { MAX_GRAPH_CONCURRENCY, MAX_GRAPH_RESOURCE_CAPACITY } from "./graph-contract.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";
import { isLoopFailureCategory } from "./loop-model-routing.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import type { OrchestrationProposalAction, OrchestrationProposalDraft } from "./orchestration-intelligence.js";
import { isValidOrchestrationResourceId } from "./orchestration-scheduler.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";
import { compareByCodePoints } from "@seekforge/shared";

export type OrchestrationProposalStatus = "proposed" | "approved" | "dismissed";

export type OrchestrationProposal = OrchestrationProposalDraft & {
  status: OrchestrationProposalStatus;
  createdAt: string;
  updatedAt: string;
};

const PATH = ".seekforge/orchestration-proposals.json";
const MAX_BYTES = 256 * 1024;
const MAX_PROPOSALS = 128;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^opt-[a-f0-9]{20}$/;

export function isOrchestrationProposalAction(value: unknown): value is OrchestrationProposalAction {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "graph_concurrency") {
    return (
      hasOnlyKeys(value, ["kind", "value"]) &&
      Number.isSafeInteger(value.value) &&
      (value.value as number) >= 1 &&
      (value.value as number) <= MAX_GRAPH_CONCURRENCY
    );
  }
  if (value.kind === "graph_resource_capacity") {
    return (
      hasOnlyKeys(value, ["kind", "resource", "value"]) &&
      isValidOrchestrationResourceId(value.resource) &&
      Number.isSafeInteger(value.value) &&
      (value.value as number) >= 1 &&
      (value.value as number) <= MAX_GRAPH_RESOURCE_CAPACITY
    );
  }
  if (value.kind === "loop_route") {
    return (
      hasOnlyKeys(value, ["kind", "failureCategory", "model"]) &&
      isLoopFailureCategory(value.failureCategory) &&
      typeof value.model === "string" &&
      value.model.trim().length > 0 &&
      value.model.length <= 256
    );
  }
  if (value.kind === "budget_review") {
    return (
      hasOnlyKeys(value, ["kind", "budget", "forecastIterations"]) &&
      typeof value.budget === "string" &&
      ["cost", "tokens", "duration", "verify_runs", "iterations"].includes(value.budget) &&
      Number.isSafeInteger(value.forecastIterations) &&
      (value.forecastIterations as number) >= 0
    );
  }
  if (value.kind === "executor_placement") {
    return (
      hasOnlyKeys(value, ["kind", "nodeId", "executor"]) &&
      isValidLoopDagId(value.nodeId) &&
      isValidLoopDagId(value.executor)
    );
  }
  return false;
}

export function isOrchestrationProposalActionForScope(
  scope: unknown,
  action: unknown,
): action is OrchestrationProposalAction {
  if (!isOrchestrationProposalAction(action)) return false;
  return scope === "loop"
    ? action.kind === "loop_route" || action.kind === "budget_review"
    : scope === "graph"
      ? action.kind === "graph_concurrency" ||
        action.kind === "graph_resource_capacity" ||
        action.kind === "executor_placement"
      : false;
}

function validProposal(value: unknown): value is OrchestrationProposal {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "scope",
      "sourceId",
      "sourceFingerprint",
      "confidence",
      "evidenceCount",
      "risk",
      "title",
      "rationale",
      "action",
      "status",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return false;
  }
  const createdAt = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
  const updatedAt = typeof value.updatedAt === "string" ? Date.parse(value.updatedAt) : Number.NaN;
  return (
    typeof value.id === "string" &&
    ID_RE.test(value.id) &&
    (value.scope === "loop" || value.scope === "graph") &&
    isValidLoopDagId(value.sourceId) &&
    typeof value.sourceFingerprint === "string" &&
    FINGERPRINT_RE.test(value.sourceFingerprint) &&
    ["none", "low", "medium", "high"].includes(String(value.confidence)) &&
    Number.isSafeInteger(value.evidenceCount) &&
    (value.evidenceCount as number) >= 0 &&
    ["low", "medium", "high"].includes(String(value.risk)) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= 256 &&
    typeof value.rationale === "string" &&
    value.rationale.length > 0 &&
    value.rationale.length <= 2_048 &&
    isOrchestrationProposalActionForScope(value.scope, value.action) &&
    ["proposed", "approved", "dismissed"].includes(String(value.status)) &&
    Number.isFinite(createdAt) &&
    Number.isFinite(updatedAt) &&
    updatedAt >= createdAt
  );
}

function parseDocument(raw: string): OrchestrationProposal[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "proposals"]) ||
      value.version !== 1 ||
      !isDenseArray(value.proposals) ||
      value.proposals.length > MAX_PROPOSALS ||
      !value.proposals.every(validProposal) ||
      new Set(value.proposals.map((proposal) => proposal.id)).size !== value.proposals.length
    ) {
      return null;
    }
    return value.proposals;
  } catch {
    return null;
  }
}

function draftMatches(proposal: OrchestrationProposal, draft: OrchestrationProposalDraft): boolean {
  const { status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...currentDraft } = proposal;
  return isDeepStrictEqual(currentDraft, draft);
}

function readUnlocked(workspace: string): OrchestrationProposal[] {
  try {
    const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
    return raw === undefined ? [] : (parseDocument(raw) ?? []);
  } catch {
    return [];
  }
}

/** Mutations fail closed so a corrupt decision file can never be overwritten. */
function readForMutation(workspace: string): OrchestrationProposal[] {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  if (raw === undefined) return [];
  const proposals = parseDocument(raw);
  if (proposals === null) throw new Error("Persisted orchestration proposals are invalid");
  return proposals;
}

function writeUnlocked(workspace: string, proposals: readonly OrchestrationProposal[]): OrchestrationProposal[] {
  const retained = [...proposals]
    .sort(
      (left, right) =>
        Number(right.status !== "proposed") - Number(left.status !== "proposed") ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
        compareByCodePoints(left.id, right.id),
    )
    .slice(0, MAX_PROPOSALS);
  let serialized = `${JSON.stringify({ version: 1, proposals: retained })}\n`;
  while (retained.length > 0 && Buffer.byteLength(serialized) > MAX_BYTES) {
    retained.pop();
    serialized = `${JSON.stringify({ version: 1, proposals: retained })}\n`;
  }
  if (Buffer.byteLength(serialized) > MAX_BYTES)
    throw new Error("Orchestration proposals exceed the durable byte limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
  return retained;
}

export function listOrchestrationProposals(workspace: string): OrchestrationProposal[] {
  return readUnlocked(workspace).sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || compareByCodePoints(left.id, right.id),
  );
}

/** Merges generated proposals and preserves review decisions only for byte-equivalent drafts. */
export function recordOrchestrationProposals(
  workspace: string,
  drafts: readonly OrchestrationProposalDraft[],
  workspaceGuard?: SessionLease,
): OrchestrationProposal[] {
  if (!isDenseArray(drafts) || drafts.length > 2_048) {
    throw new Error("Too many or sparse orchestration proposals were generated");
  }
  const confidenceRank = { none: 0, low: 1, medium: 2, high: 3 } as const;
  const unique = new Map<string, OrchestrationProposalDraft>();
  const now = new Date().toISOString();
  for (const draft of drafts) {
    if (!validProposal({ ...draft, status: "proposed", createdAt: now, updatedAt: now })) {
      throw new Error(`Generated orchestration proposal is invalid: ${String(draft?.id)}`);
    }
    const existing = unique.get(draft.id);
    if (existing && !isDeepStrictEqual(existing, draft)) {
      throw new Error(`Conflicting orchestration proposal id: ${draft.id}`);
    }
    unique.set(draft.id, draft);
  }
  const selected = [...unique.values()]
    .sort(
      (left, right) =>
        confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
        right.evidenceCount - left.evidenceCount ||
        compareByCodePoints(left.id, right.id),
    )
    .slice(0, MAX_PROPOSALS);
  const lease = acquireSessionLease(workspace, "orchestration-proposals", workspaceGuard);
  try {
    const current = readForMutation(workspace);
    const byId = new Map(current.map((proposal) => [proposal.id, proposal]));
    for (const draft of selected) {
      const previous = byId.get(draft.id);
      const unchanged = previous !== undefined && draftMatches(previous, draft);
      const candidate: OrchestrationProposal = {
        ...draft,
        status: unchanged ? previous.status : "proposed",
        createdAt: previous?.createdAt ?? now,
        updatedAt:
          previous === undefined || unchanged
            ? (previous?.updatedAt ?? now)
            : nextOrchestrationVersion(previous.updatedAt, now),
      };
      if (!validProposal(candidate)) throw new Error(`Generated orchestration proposal is invalid: ${draft.id}`);
      byId.set(draft.id, candidate);
    }
    const retained = writeUnlocked(workspace, [...byId.values()]);
    const retainedById = new Map(retained.map((proposal) => [proposal.id, proposal]));
    return selected.flatMap((draft) => {
      const proposal = retainedById.get(draft.id);
      return proposal ? [proposal] : [];
    });
  } finally {
    lease.release();
  }
}

export function setOrchestrationProposalStatus(
  workspace: string,
  id: string,
  status: Exclude<OrchestrationProposalStatus, "proposed">,
  expectedUpdatedAt?: string,
): OrchestrationProposal {
  if (!ID_RE.test(id)) throw new Error(`Invalid orchestration proposal id: ${id}`);
  if (status !== "approved" && status !== "dismissed") throw new Error("Invalid orchestration proposal status");
  if (expectedUpdatedAt !== undefined && !Number.isFinite(Date.parse(expectedUpdatedAt))) {
    throw new Error("Orchestration proposal version is invalid");
  }
  const lease = acquireSessionLease(workspace, "orchestration-proposals");
  try {
    const proposals = readForMutation(workspace);
    const index = proposals.findIndex((proposal) => proposal.id === id);
    if (index < 0) throw new Error(`Orchestration proposal not found: ${id}`);
    const current = proposals[index]!;
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      throw new Error("Orchestration proposal changed since it was reviewed");
    }
    const updatedAt = nextOrchestrationVersion(current.updatedAt);
    const updated = { ...current, status, updatedAt } satisfies OrchestrationProposal;
    proposals[index] = updated;
    writeUnlocked(workspace, proposals);
    return updated;
  } finally {
    lease.release();
  }
}
