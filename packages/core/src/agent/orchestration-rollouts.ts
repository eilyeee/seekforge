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
import { listOrchestrationControlObservations } from "./orchestration-control.js";
import { listOrchestrationProposals } from "./orchestration-proposals.js";
import { acquireSessionLease } from "./session-lease.js";
import { fingerprintOrchestrationDecisionInput, recordOrchestrationDecision } from "./orchestration-decisions.js";

export type OrchestrationRolloutPhase = "shadow" | "canary" | "paused" | "promoted" | "rolled_back" | "failed";

export type OrchestrationRolloutTimelineEntry = {
  at: string;
  event: "started" | "stage_5" | "stage_25" | "promoted" | "paused" | "resumed" | "rolled_back" | "failed";
  reason: string;
};

export type OrchestrationRollout = {
  proposalId: string;
  proposalUpdatedAt: string;
  scope: "loop" | "graph";
  sourceId: string;
  phase: OrchestrationRolloutPhase;
  stagePercent: 0 | 5 | 25 | 100;
  minSamples: number;
  observationIds: string[];
  stageObservationIds: string[];
  timeline: OrchestrationRolloutTimelineEntry[];
  startedAt: string;
  updatedAt: string;
  canaryAt?: string;
  promotedAt?: string;
  rolledBackAt?: string;
  pausedAt?: string;
  lastVerdict?: Exclude<OrchestrationDeploymentVerdict, "pending">;
  error?: string;
};

const PATH = ".seekforge/orchestration-rollouts.json";
const MAX_BYTES = 256 * 1024;
const MAX_ROLLOUTS = 64;
const MAX_OBSERVATIONS = 32;
const MAX_CANARY_SAMPLES = 32;
const MAX_TIMELINE = 64;
const PROPOSAL_RE = /^opt-[a-f0-9]{20}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validObservationIds(value: unknown): value is string[] {
  return isDenseArray(value) && value.every((id) => typeof id === "string" && HASH_RE.test(id));
}

function validStageObservationIds(value: unknown, observationIds: unknown): value is string[] {
  return (
    validObservationIds(value) &&
    validObservationIds(observationIds) &&
    value.every((id) => observationIds.includes(id))
  );
}

function validTimeline(value: unknown): value is OrchestrationRolloutTimelineEntry[] {
  return (
    isDenseArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ["at", "event", "reason"]) &&
        typeof entry.at === "string" &&
        Number.isFinite(Date.parse(entry.at)) &&
        ["started", "stage_5", "stage_25", "promoted", "paused", "resumed", "rolled_back", "failed"].includes(
          String(entry.event),
        ) &&
        typeof entry.reason === "string" &&
        entry.reason.length > 0 &&
        entry.reason.length <= 1_024,
    )
  );
}

function appendTimeline(
  timeline: readonly OrchestrationRolloutTimelineEntry[],
  entry: OrchestrationRolloutTimelineEntry,
): OrchestrationRolloutTimelineEntry[] {
  return [...timeline, entry].slice(-MAX_TIMELINE);
}

function validRollout(value: unknown): value is OrchestrationRollout {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "proposalId",
      "proposalUpdatedAt",
      "scope",
      "sourceId",
      "phase",
      "stagePercent",
      "minSamples",
      "observationIds",
      "stageObservationIds",
      "timeline",
      "startedAt",
      "updatedAt",
      "canaryAt",
      "promotedAt",
      "rolledBackAt",
      "pausedAt",
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
    !["shadow", "canary", "paused", "promoted", "rolled_back", "failed"].includes(String(value.phase)) ||
    ![0, 5, 25, 100].includes(value.stagePercent as number) ||
    !Number.isSafeInteger(value.minSamples) ||
    (value.minSamples as number) < 1 ||
    (value.minSamples as number) > MAX_CANARY_SAMPLES ||
    !validObservationIds(value.observationIds) ||
    value.observationIds.length > MAX_OBSERVATIONS ||
    new Set(value.observationIds).size !== value.observationIds.length ||
    !validStageObservationIds(value.stageObservationIds, value.observationIds) ||
    value.stageObservationIds.length > MAX_OBSERVATIONS ||
    !validTimeline(value.timeline) ||
    value.timeline.length < 1 ||
    value.timeline.length > MAX_TIMELINE ||
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
  const updatedAt = value.updatedAt as string;
  const timestamps = [value.canaryAt, value.promotedAt, value.rolledBackAt, value.pausedAt].filter(
    (item): item is string => item !== undefined,
  );
  if (timestamps.some((item) => !Number.isFinite(Date.parse(item)) || Date.parse(item) < Date.parse(startedAt))) {
    return false;
  }
  if (
    value.timeline.some(
      (entry) => Date.parse(entry.at) < Date.parse(startedAt) || Date.parse(entry.at) > Date.parse(updatedAt),
    )
  ) {
    return false;
  }
  return (
    (value.phase === "shadow" &&
      value.stagePercent === 0 &&
      value.canaryAt === undefined &&
      value.promotedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.pausedAt === undefined &&
      value.lastVerdict === undefined &&
      value.error === undefined) ||
    (value.phase === "canary" &&
      (value.stagePercent === 5 || value.stagePercent === 25) &&
      typeof value.canaryAt === "string" &&
      value.promotedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.pausedAt === undefined &&
      value.error === undefined) ||
    (value.phase === "paused" &&
      (value.stagePercent === 5 || value.stagePercent === 25) &&
      typeof value.canaryAt === "string" &&
      typeof value.pausedAt === "string" &&
      value.promotedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.error === undefined) ||
    (value.phase === "promoted" &&
      value.stagePercent === 100 &&
      typeof value.canaryAt === "string" &&
      typeof value.promotedAt === "string" &&
      value.rolledBackAt === undefined &&
      value.pausedAt === undefined &&
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
    value.rollouts.length > MAX_ROLLOUTS
  ) {
    throw new Error("Persisted orchestration rollouts are invalid");
  }
  const rollouts = value.rollouts.map((item): unknown => {
    if (!isRecord(item) || item.stagePercent !== undefined) return item;
    const stagePercent = item.phase === "shadow" ? 0 : item.phase === "promoted" ? 100 : 5;
    return {
      ...item,
      stagePercent,
      stageObservationIds: isDenseArray(item.observationIds) ? item.observationIds : [],
      timeline: [
        {
          at: typeof item.startedAt === "string" ? item.startedAt : new Date(0).toISOString(),
          event: item.phase === "shadow" ? "started" : item.phase === "promoted" ? "promoted" : "stage_5",
          reason: "Migrated from the single-canary rollout format",
        },
      ],
    };
  });
  if (
    !rollouts.every(validRollout) ||
    new Set(rollouts.map((item) => (item as OrchestrationRollout).proposalId)).size !== rollouts.length
  ) {
    throw new Error("Persisted orchestration rollouts are invalid");
  }
  return rollouts as OrchestrationRollout[];
}

function writeRollout(workspace: string, rollout: OrchestrationRollout): OrchestrationRollout {
  if (!validRollout(rollout)) throw new Error("Orchestration rollout is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-rollouts");
  try {
    const current = readUnlocked(workspace).filter((item) => item.proposalId !== rollout.proposalId);
    const ordered = [...current, rollout].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    const active = ordered.filter(
      (item) => item.phase === "shadow" || item.phase === "canary" || item.phase === "paused",
    );
    if (active.length > MAX_ROLLOUTS) throw new Error("Too many active orchestration rollouts");
    let retained = [
      ...active,
      ...ordered.filter((item) => item.phase !== "shadow" && item.phase !== "canary" && item.phase !== "paused"),
    ].slice(0, MAX_ROLLOUTS);
    let serialized = `${JSON.stringify({ version: 1, rollouts: retained })}\n`;
    while (Buffer.byteLength(serialized) > MAX_BYTES) {
      let oldestTerminal = -1;
      for (let index = retained.length - 1; index >= 0; index--) {
        const item = retained[index]!;
        if (item.phase !== "shadow" && item.phase !== "canary" && item.phase !== "paused") {
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

function recordRolloutGateDecision(
  workspace: string,
  rollout: OrchestrationRollout,
  status: "adopted" | "rejected",
  reason: string,
): void {
  try {
    recordOrchestrationDecision(workspace, {
      kind: "rollout_gate",
      scope: rollout.scope,
      sourceId: rollout.sourceId,
      policyVersion: 2,
      inputFingerprint: fingerprintOrchestrationDecisionInput({
        proposalId: rollout.proposalId,
        proposalUpdatedAt: rollout.proposalUpdatedAt,
        stagePercent: rollout.stagePercent,
        stageObservationIds: rollout.stageObservationIds,
        lastVerdict: rollout.lastVerdict,
      }),
      status,
      reasons: [reason],
      selected: [rollout.proposalId],
    });
  } catch {
    // Rollout state is authoritative when observational decision logging fails.
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
  const minSamples = options.minSamples ?? 3;
  if (!Number.isSafeInteger(minSamples) || minSamples < 1 || minSamples > MAX_CANARY_SAMPLES) {
    throw new RangeError(`Orchestration rollout minSamples must be from 1 to ${MAX_CANARY_SAMPLES}`);
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
      stagePercent: 0,
      minSamples,
      observationIds: [],
      stageObservationIds: [],
      timeline: [{ at: now, event: "started", reason: "Approved proposal entered shadow evaluation" }],
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
        return writeRollout(workspace, {
          ...rollout,
          phase: "canary",
          stagePercent: 5,
          stageObservationIds: [],
          canaryAt,
          updatedAt: canaryAt,
          timeline: appendTimeline(rollout.timeline, {
            at: canaryAt,
            event: "stage_5",
            reason: "Exact proposal generation deployed to the 5% cohort",
          }),
        });
      } catch (error) {
        const updatedAt = nextOrchestrationVersion(rollout.updatedAt);
        writeRollout(workspace, {
          ...rollout,
          phase: "failed",
          updatedAt,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Rollout failed",
          timeline: appendTimeline(rollout.timeline, {
            at: updatedAt,
            event: "failed",
            reason: "The rollout deployment failed",
          }),
        });
        throw error;
      }
    }
    if (rollout.phase === "canary") {
      if (rollout.stageObservationIds.length < rollout.minSamples || rollout.lastVerdict === undefined) {
        throw new Error("Orchestration rollout needs more terminal canary observations");
      }
      if (rollout.lastVerdict === "regressed") {
        const pausedAt = nextOrchestrationVersion(rollout.updatedAt);
        const paused = writeRollout(workspace, {
          ...rollout,
          phase: "paused",
          pausedAt,
          updatedAt: pausedAt,
          timeline: appendTimeline(rollout.timeline, {
            at: pausedAt,
            event: "paused",
            reason: "A canary observation regressed",
          }),
        });
        recordRolloutGateDecision(workspace, paused, "rejected", "A canary observation regressed");
        return paused;
      }
      if (rollout.stagePercent === 5) {
        const updatedAt = nextOrchestrationVersion(rollout.updatedAt);
        const advanced = writeRollout(workspace, {
          ...rollout,
          stagePercent: 25,
          stageObservationIds: [],
          updatedAt,
          timeline: appendTimeline(rollout.timeline, {
            at: updatedAt,
            event: "stage_25",
            reason: "The 5% cohort met its evidence gate",
          }),
        });
        recordRolloutGateDecision(workspace, rollout, "adopted", "The 5% cohort met its evidence gate");
        return advanced;
      }
      const promotedAt = nextOrchestrationVersion(rollout.updatedAt);
      const promoted = writeRollout(workspace, {
        ...rollout,
        phase: "promoted",
        stagePercent: 100,
        promotedAt,
        updatedAt: promotedAt,
        timeline: appendTimeline(rollout.timeline, {
          at: promotedAt,
          event: "promoted",
          reason: "The 25% cohort met its evidence gate",
        }),
      });
      recordRolloutGateDecision(workspace, rollout, "adopted", "The 25% cohort met its evidence gate");
      return promoted;
    }
    return rollout;
  } finally {
    lease.release();
  }
}

export function recordOrchestrationRolloutSample(
  workspace: string,
  proposalId: string,
  sample: { observationId: string; verdict: Exclude<OrchestrationDeploymentVerdict, "pending"> },
): OrchestrationRollout {
  if (!PROPOSAL_RE.test(proposalId) || !HASH_RE.test(sample.observationId)) {
    throw new Error("Orchestration rollout sample identity is invalid");
  }
  if (!["improved", "stable", "regressed"].includes(sample.verdict)) {
    throw new Error("Orchestration rollout sample verdict is invalid");
  }
  const observation = listOrchestrationControlObservations(workspace).observations.find(
    (candidate) => candidate.id === sample.observationId,
  );
  const lease = acquireSessionLease(workspace, `orchestration-rollout-${proposalId}`);
  try {
    const rollout = readUnlocked(workspace).find((item) => item.proposalId === proposalId);
    if (rollout?.phase !== "canary") throw new Error("Orchestration rollout is not accepting samples");
    if (
      !observation ||
      observation.proposalId !== proposalId ||
      observation.proposalUpdatedAt !== rollout.proposalUpdatedAt ||
      observation.verdict !== sample.verdict
    ) {
      throw new Error("Orchestration rollout sample is not durable evidence for this exact proposal generation");
    }
    if (rollout.observationIds.includes(sample.observationId)) return rollout;
    const updatedAt = nextOrchestrationVersion(rollout.updatedAt);
    if (sample.verdict === "regressed") {
      const paused = writeRollout(workspace, {
        ...rollout,
        phase: "paused",
        observationIds: [...rollout.observationIds, sample.observationId].slice(-MAX_OBSERVATIONS),
        stageObservationIds: [...rollout.stageObservationIds, sample.observationId].slice(-MAX_OBSERVATIONS),
        lastVerdict: "regressed",
        pausedAt: updatedAt,
        updatedAt,
        timeline: appendTimeline(rollout.timeline, {
          at: updatedAt,
          event: "paused",
          reason: "A cohort sample regressed",
        }),
      });
      recordRolloutGateDecision(workspace, paused, "rejected", "A cohort sample regressed");
      return paused;
    }
    return writeRollout(workspace, {
      ...rollout,
      observationIds: [...rollout.observationIds, sample.observationId].slice(-MAX_OBSERVATIONS),
      stageObservationIds: [...rollout.stageObservationIds, sample.observationId].slice(-MAX_OBSERVATIONS),
      lastVerdict: sample.verdict,
      updatedAt,
    });
  } finally {
    lease.release();
  }
}

export function resumeOrchestrationRollout(workspace: string, proposalId: string): OrchestrationRollout {
  if (!PROPOSAL_RE.test(proposalId)) throw new Error(`Invalid orchestration proposal id: ${proposalId}`);
  const lease = acquireSessionLease(workspace, `orchestration-rollout-${proposalId}`);
  try {
    const rollout = readUnlocked(workspace).find((item) => item.proposalId === proposalId);
    if (!rollout) throw new Error(`Orchestration rollout not found: ${proposalId}`);
    if (rollout.phase !== "paused") return rollout;
    const updatedAt = nextOrchestrationVersion(rollout.updatedAt);
    return writeRollout(workspace, {
      ...rollout,
      phase: "canary",
      pausedAt: undefined,
      stageObservationIds: [],
      lastVerdict: undefined,
      updatedAt,
      timeline: appendTimeline(rollout.timeline, {
        at: updatedAt,
        event: "resumed",
        reason: "Operator resumed the current cohort with a fresh evidence window",
      }),
    });
  } finally {
    lease.release();
  }
}

export function pauseOrchestrationRollout(
  workspace: string,
  proposalId: string,
  reason = "Operator paused the current cohort",
): OrchestrationRollout {
  if (!PROPOSAL_RE.test(proposalId)) throw new Error(`Invalid orchestration proposal id: ${proposalId}`);
  const normalizedReason = reason.trim();
  if (normalizedReason.length === 0 || normalizedReason.length > 1_024) {
    throw new Error("Orchestration rollout pause reason is invalid");
  }
  const lease = acquireSessionLease(workspace, `orchestration-rollout-${proposalId}`);
  try {
    const rollout = readUnlocked(workspace).find((item) => item.proposalId === proposalId);
    if (!rollout) throw new Error(`Orchestration rollout not found: ${proposalId}`);
    if (rollout.phase !== "canary") return rollout;
    const pausedAt = nextOrchestrationVersion(rollout.updatedAt);
    const paused = writeRollout(workspace, {
      ...rollout,
      phase: "paused",
      pausedAt,
      updatedAt: pausedAt,
      timeline: appendTimeline(rollout.timeline, { at: pausedAt, event: "paused", reason: normalizedReason }),
    });
    recordRolloutGateDecision(workspace, rollout, "rejected", normalizedReason);
    return paused;
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
      !(
        (candidate.phase === "promoted" || candidate.phase === "paused") &&
        candidateDeployment?.status === "rolled_back"
      )
    ) {
      results.push(candidate);
      continue;
    }
    const lease = acquireSessionLease(workspace, `orchestration-rollout-${candidate.proposalId}`);
    try {
      const rollout = readUnlocked(workspace).find((item) => item.proposalId === candidate.proposalId);
      const deployment = deployments.get(candidate.proposalId);
      if (rollout?.phase !== "canary" || !deployment) {
        if ((rollout?.phase === "promoted" || rollout?.phase === "paused") && deployment?.status === "rolled_back") {
          const rolledBackAt = nextOrchestrationVersion(
            rollout.updatedAt,
            deployment.rolledBackAt ?? deployment.updatedAt,
          );
          const rolledBack = writeRollout(workspace, {
            ...rollout,
            phase: "rolled_back",
            updatedAt: rolledBackAt,
            rolledBackAt,
            timeline: appendTimeline(rollout.timeline, {
              at: rolledBackAt,
              event: "rolled_back",
              reason: "The underlying deployment was rolled back",
            }),
          });
          recordRolloutGateDecision(workspace, rollout, "rejected", "The underlying deployment was rolled back");
          results.push(rolledBack);
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
        const rolledBack = writeRollout(workspace, {
          ...rollout,
          phase: "rolled_back",
          observationIds,
          updatedAt: rolledBackAt,
          rolledBackAt,
          timeline: appendTimeline(rollout.timeline, {
            at: rolledBackAt,
            event: "rolled_back",
            reason: "The underlying deployment was rolled back",
          }),
          ...(observation ? { lastVerdict: observation.verdict } : {}),
        });
        recordRolloutGateDecision(workspace, rollout, "rejected", "The underlying deployment was rolled back");
        results.push(rolledBack);
        continue;
      }
      if (!observation) {
        results.push(rollout);
        continue;
      }
      const observationIds = [...new Set([...rollout.observationIds, observation.id])].slice(-MAX_OBSERVATIONS);
      const stageObservationIds = rollout.observationIds.includes(observation.id)
        ? rollout.stageObservationIds
        : [...rollout.stageObservationIds, observation.id].slice(-MAX_OBSERVATIONS);
      const updatedAt = nextOrchestrationVersion(rollout.updatedAt, deployment.updatedAt);
      const observed = writeRollout(workspace, {
        ...rollout,
        observationIds,
        stageObservationIds,
        updatedAt,
        lastVerdict: observation.verdict,
      });
      if (observation.verdict === "regressed" && options.autoRollback) {
        const rolled = rollbackOrchestrationDeployment(workspace, rollout.proposalId);
        const rolledBackAt = nextOrchestrationVersion(observed.updatedAt, rolled.updatedAt);
        const rolledBack = writeRollout(workspace, {
          ...observed,
          phase: "rolled_back",
          updatedAt: rolledBackAt,
          rolledBackAt,
          lastVerdict: "regressed",
          timeline: appendTimeline(observed.timeline, {
            at: rolledBackAt,
            event: "rolled_back",
            reason: "A canary regression triggered automatic rollback",
          }),
        });
        recordRolloutGateDecision(workspace, observed, "rejected", "A canary regression triggered automatic rollback");
        results.push(rolledBack);
      } else if (observation.verdict === "regressed") {
        const pausedAt = nextOrchestrationVersion(observed.updatedAt);
        const paused = writeRollout(workspace, {
          ...observed,
          phase: "paused",
          pausedAt,
          updatedAt: pausedAt,
          timeline: appendTimeline(observed.timeline, {
            at: pausedAt,
            event: "paused",
            reason: "A canary regression requires operator review",
          }),
        });
        recordRolloutGateDecision(workspace, observed, "rejected", "A canary regression requires operator review");
        results.push(paused);
      } else if (stageObservationIds.length >= rollout.minSamples && rollout.stagePercent === 5) {
        const stageAt = nextOrchestrationVersion(observed.updatedAt);
        const advanced = writeRollout(workspace, {
          ...observed,
          stagePercent: 25,
          stageObservationIds: [],
          updatedAt: stageAt,
          timeline: appendTimeline(observed.timeline, {
            at: stageAt,
            event: "stage_25",
            reason: "The 5% cohort met its evidence gate",
          }),
        });
        recordRolloutGateDecision(workspace, observed, "adopted", "The 5% cohort met its evidence gate");
        results.push(advanced);
      } else if (stageObservationIds.length >= rollout.minSamples && rollout.stagePercent === 25) {
        const promotedAt = nextOrchestrationVersion(observed.updatedAt);
        const promoted = writeRollout(workspace, {
          ...observed,
          phase: "promoted",
          stagePercent: 100,
          updatedAt: promotedAt,
          promotedAt,
          timeline: appendTimeline(observed.timeline, {
            at: promotedAt,
            event: "promoted",
            reason: "The 25% cohort met its evidence gate",
          }),
        });
        recordRolloutGateDecision(workspace, observed, "adopted", "The 25% cohort met its evidence gate");
        results.push(promoted);
      } else results.push(observed);
    } finally {
      lease.release();
    }
  }
  return results;
}
