import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import {
  applyOrchestrationProposal,
  observeOrchestrationDeployments,
  rollbackOrchestrationDeployment,
  type ApplyOrchestrationProposalOptions,
  type OrchestrationDeploymentVerdict,
} from "./orchestration-deployments.js";
import { recordOrchestrationDeploymentObservation } from "./orchestration-control.js";
import { listOrchestrationProposals } from "./orchestration-proposals.js";
import { acquireSessionLease } from "./session-lease.js";

export type OrchestrationRolloutPhase = "shadow" | "canary" | "promoted" | "rolled_back" | "failed";

export type OrchestrationRollout = {
  proposalId: string;
  proposalUpdatedAt: string;
  scope: "loop" | "graph";
  sourceId: string;
  phase: OrchestrationRolloutPhase;
  minSamples: number;
  observationIds: string[];
  startedAt: string;
  updatedAt: string;
  canaryAt?: string;
  promotedAt?: string;
  rolledBackAt?: string;
  lastVerdict?: Exclude<OrchestrationDeploymentVerdict, "pending">;
  error?: string;
};

const PATH = ".seekforge/orchestration-rollouts.json";
const MAX_BYTES = 256 * 1024;
const MAX_ROLLOUTS = 64;
const MAX_OBSERVATIONS = 32;
const MAX_CANARY_SAMPLES = 1;
const PROPOSAL_RE = /^opt-[a-f0-9]{20}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validRollout(value: unknown): value is OrchestrationRollout {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "proposalId",
      "proposalUpdatedAt",
      "scope",
      "sourceId",
      "phase",
      "minSamples",
      "observationIds",
      "startedAt",
      "updatedAt",
      "canaryAt",
      "promotedAt",
      "rolledBackAt",
      "lastVerdict",
      "error",
    ]) ||
    typeof value.proposalId !== "string" ||
    !PROPOSAL_RE.test(value.proposalId) ||
    typeof value.proposalUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.proposalUpdatedAt)) ||
    (value.scope !== "loop" && value.scope !== "graph") ||
    typeof value.sourceId !== "string" ||
    !ID_RE.test(value.sourceId) ||
    !["shadow", "canary", "promoted", "rolled_back", "failed"].includes(String(value.phase)) ||
    !Number.isSafeInteger(value.minSamples) ||
    (value.minSamples as number) < 1 ||
    (value.minSamples as number) > MAX_CANARY_SAMPLES ||
    !isDenseArray(value.observationIds) ||
    value.observationIds.length > MAX_OBSERVATIONS ||
    !value.observationIds.every((id) => typeof id === "string" && HASH_RE.test(id)) ||
    new Set(value.observationIds).size !== value.observationIds.length ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    Date.parse(value.updatedAt) < Date.parse(value.startedAt) ||
    (value.lastVerdict !== undefined &&
      value.lastVerdict !== "improved" &&
      value.lastVerdict !== "stable" &&
      value.lastVerdict !== "regressed") ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length === 0 || value.error.length > 4_096))
  ) {
    return false;
  }
  const startedAt = value.startedAt as string;
  const timestamps = [value.canaryAt, value.promotedAt, value.rolledBackAt].filter(
    (item): item is string => item !== undefined,
  );
  if (timestamps.some((item) => !Number.isFinite(Date.parse(item)) || Date.parse(item) < Date.parse(startedAt))) {
    return false;
  }
  return (
    (value.phase === "shadow" &&
      value.canaryAt === undefined &&
      value.promotedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.lastVerdict === undefined &&
      value.error === undefined) ||
    (value.phase === "canary" &&
      typeof value.canaryAt === "string" &&
      value.promotedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.error === undefined) ||
    (value.phase === "promoted" &&
      typeof value.canaryAt === "string" &&
      typeof value.promotedAt === "string" &&
      value.rolledBackAt === undefined &&
      value.error === undefined) ||
    (value.phase === "rolled_back" &&
      typeof value.canaryAt === "string" &&
      typeof value.rolledBackAt === "string" &&
      value.error === undefined) ||
    (value.phase === "failed" && typeof value.error === "string")
  );
}

function readUnlocked(workspace: string): OrchestrationRollout[] {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  if (raw === undefined) return [];
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "rollouts"]) ||
    value.version !== 1 ||
    !isDenseArray(value.rollouts) ||
    value.rollouts.length > MAX_ROLLOUTS ||
    !value.rollouts.every(validRollout) ||
    new Set(value.rollouts.map((item) => item.proposalId)).size !== value.rollouts.length
  ) {
    throw new Error("Persisted orchestration rollouts are invalid");
  }
  return value.rollouts;
}

function writeRollout(workspace: string, rollout: OrchestrationRollout): OrchestrationRollout {
  if (!validRollout(rollout)) throw new Error("Orchestration rollout is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-rollouts");
  try {
    const current = readUnlocked(workspace).filter((item) => item.proposalId !== rollout.proposalId);
    const ordered = [...current, rollout].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const active = ordered.filter((item) => item.phase === "shadow" || item.phase === "canary");
    if (active.length > MAX_ROLLOUTS) throw new Error("Too many active orchestration rollouts");
    let retained = [...active, ...ordered.filter((item) => item.phase !== "shadow" && item.phase !== "canary")].slice(
      0,
      MAX_ROLLOUTS,
    );
    let serialized = `${JSON.stringify({ version: 1, rollouts: retained })}\n`;
    while (Buffer.byteLength(serialized) > MAX_BYTES) {
      let oldestTerminal = -1;
      for (let index = retained.length - 1; index >= 0; index--) {
        const item = retained[index]!;
        if (item.phase !== "shadow" && item.phase !== "canary") {
          oldestTerminal = index;
          break;
        }
      }
      if (oldestTerminal < 0) break;
      retained = retained.filter((_, index) => index !== oldestTerminal);
      serialized = `${JSON.stringify({ version: 1, rollouts: retained })}\n`;
    }
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Orchestration rollouts exceed limit");
    writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
    return rollout;
  } finally {
    lease.release();
  }
}

export function listOrchestrationRollouts(workspace: string): OrchestrationRollout[] {
  return readUnlocked(workspace);
}

export function startOrchestrationRollout(
  workspace: string,
  proposalId: string,
  options: { expectedUpdatedAt?: string; minSamples?: number } = {},
): OrchestrationRollout {
  if (!PROPOSAL_RE.test(proposalId)) throw new Error(`Invalid orchestration proposal id: ${proposalId}`);
  const minSamples = options.minSamples ?? 1;
  if (!Number.isSafeInteger(minSamples) || minSamples < 1 || minSamples > MAX_CANARY_SAMPLES) {
    throw new RangeError("Orchestration rollout minSamples must be 1 for a single exact-generation canary");
  }
  const lease = acquireSessionLease(workspace, `orchestration-rollout-${proposalId}`);
  try {
    const proposal = listOrchestrationProposals(workspace).find((item) => item.id === proposalId);
    if (!proposal) throw new Error(`Orchestration proposal not found: ${proposalId}`);
    if (proposal.status !== "approved") throw new Error("Orchestration proposal must be approved before rollout");
    if (options.expectedUpdatedAt !== undefined && proposal.updatedAt !== options.expectedUpdatedAt) {
      throw new Error("Orchestration proposal changed since it was approved");
    }
    const existing = readUnlocked(workspace).find((item) => item.proposalId === proposalId);
    if (existing && existing.proposalUpdatedAt === proposal.updatedAt && existing.phase !== "failed") return existing;
    const now = nextOrchestrationVersion(proposal.updatedAt);
    return writeRollout(workspace, {
      proposalId,
      proposalUpdatedAt: proposal.updatedAt,
      scope: proposal.scope,
      sourceId: proposal.sourceId,
      phase: "shadow",
      minSamples,
      observationIds: [],
      startedAt: now,
      updatedAt: now,
    });
  } finally {
    lease.release();
  }
}

export function advanceOrchestrationRollout(
  workspace: string,
  proposalId: string,
  options: ApplyOrchestrationProposalOptions = {},
): OrchestrationRollout {
  if (!PROPOSAL_RE.test(proposalId)) throw new Error(`Invalid orchestration proposal id: ${proposalId}`);
  const lease = acquireSessionLease(workspace, `orchestration-rollout-${proposalId}`);
  try {
    const rollout = readUnlocked(workspace).find((item) => item.proposalId === proposalId);
    if (!rollout) throw new Error(`Orchestration rollout not found: ${proposalId}`);
    if (rollout.phase === "shadow") {
      try {
        const deployment = applyOrchestrationProposal(workspace, proposalId, {
          ...options,
          expectedUpdatedAt: rollout.proposalUpdatedAt,
        });
        const canaryAt = nextOrchestrationVersion(rollout.updatedAt, deployment.updatedAt);
        return writeRollout(workspace, { ...rollout, phase: "canary", canaryAt, updatedAt: canaryAt });
      } catch (error) {
        const updatedAt = nextOrchestrationVersion(rollout.updatedAt);
        writeRollout(workspace, {
          ...rollout,
          phase: "failed",
          updatedAt,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Rollout failed",
        });
        throw error;
      }
    }
    if (rollout.phase === "canary") {
      if (rollout.observationIds.length < rollout.minSamples || rollout.lastVerdict === undefined) {
        throw new Error("Orchestration rollout needs more terminal canary observations");
      }
      if (rollout.lastVerdict === "regressed") throw new Error("A regressed rollout cannot be promoted");
      const promotedAt = nextOrchestrationVersion(rollout.updatedAt);
      return writeRollout(workspace, { ...rollout, phase: "promoted", promotedAt, updatedAt: promotedAt });
    }
    return rollout;
  } finally {
    lease.release();
  }
}

/** Observes canaries, records unique evidence, promotes healthy samples, and rolls regressions back. */
export function reconcileOrchestrationRollouts(
  workspace: string,
  options: { autoRollback?: boolean } = {},
): OrchestrationRollout[] {
  const observedDeployments = observeOrchestrationDeployments(workspace, {
    autoRollback: options.autoRollback === true,
  });
  for (const deployment of observedDeployments) recordOrchestrationDeploymentObservation(workspace, deployment);
  const deployments = new Map(observedDeployments.map((deployment) => [deployment.proposalId, deployment]));
  const results: OrchestrationRollout[] = [];
  for (const candidate of readUnlocked(workspace)) {
    const candidateDeployment = deployments.get(candidate.proposalId);
    if (
      candidate.phase !== "canary" &&
      !(candidate.phase === "promoted" && candidateDeployment?.status === "rolled_back")
    ) {
      results.push(candidate);
      continue;
    }
    const lease = acquireSessionLease(workspace, `orchestration-rollout-${candidate.proposalId}`);
    try {
      const rollout = readUnlocked(workspace).find((item) => item.proposalId === candidate.proposalId);
      const deployment = deployments.get(candidate.proposalId);
      if (rollout?.phase !== "canary" || !deployment) {
        if (rollout?.phase === "promoted" && deployment?.status === "rolled_back") {
          const rolledBackAt = nextOrchestrationVersion(
            rollout.updatedAt,
            deployment.rolledBackAt ?? deployment.updatedAt,
          );
          results.push(
            writeRollout(workspace, { ...rollout, phase: "rolled_back", updatedAt: rolledBackAt, rolledBackAt }),
          );
        } else if (rollout) results.push(rollout);
        continue;
      }
      const observation = recordOrchestrationDeploymentObservation(workspace, deployment);
      if (deployment.status === "rolled_back") {
        const observationIds = observation
          ? [...new Set([...rollout.observationIds, observation.id])].slice(-MAX_OBSERVATIONS)
          : rollout.observationIds;
        const rolledBackAt = nextOrchestrationVersion(
          rollout.updatedAt,
          deployment.rolledBackAt ?? deployment.updatedAt,
        );
        results.push(
          writeRollout(workspace, {
            ...rollout,
            phase: "rolled_back",
            observationIds,
            updatedAt: rolledBackAt,
            rolledBackAt,
            ...(observation ? { lastVerdict: observation.verdict } : {}),
          }),
        );
        continue;
      }
      if (!observation) {
        results.push(rollout);
        continue;
      }
      const observationIds = [...new Set([...rollout.observationIds, observation.id])].slice(-MAX_OBSERVATIONS);
      const updatedAt = nextOrchestrationVersion(rollout.updatedAt, deployment.updatedAt);
      const observed = writeRollout(workspace, {
        ...rollout,
        observationIds,
        updatedAt,
        lastVerdict: observation.verdict,
      });
      if (observation.verdict === "regressed" && options.autoRollback) {
        const rolled = rollbackOrchestrationDeployment(workspace, rollout.proposalId);
        const rolledBackAt = nextOrchestrationVersion(observed.updatedAt, rolled.updatedAt);
        results.push(
          writeRollout(workspace, {
            ...observed,
            phase: "rolled_back",
            updatedAt: rolledBackAt,
            rolledBackAt,
            lastVerdict: "regressed",
          }),
        );
      } else if (observation.verdict !== "regressed" && observationIds.length >= rollout.minSamples) {
        const promotedAt = nextOrchestrationVersion(observed.updatedAt);
        results.push(writeRollout(workspace, { ...observed, phase: "promoted", updatedAt: promotedAt, promotedAt }));
      } else results.push(observed);
    } finally {
      lease.release();
    }
  }
  return results;
}
