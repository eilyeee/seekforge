import { createHash } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { parseEngineeringGraphDefinition, type EngineeringGraphDefinition } from "./graph-contract.js";
import { graphExecutionAdapterEligibility, type GraphExecutionAdapter } from "./graph-engineering.js";
import { applyEngineeringGraphMigration, readEngineeringGraphMigrationJournal } from "./graph-migration.js";
import { loadEngineeringGraphState } from "./graph-state.js";
import { acquireLoopLifecycleLease, loadLoopState } from "./loop-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import {
  graphOrchestrationFingerprint,
  loopOrchestrationFingerprint,
  type OrchestrationProposalAction,
} from "./orchestration-intelligence.js";
import {
  applyLoopRoutePolicy,
  isAppliedLoopRoute,
  readAppliedLoopRoute,
  rollbackLoopRoutePolicy,
  type AppliedLoopRoute,
} from "./orchestration-policy.js";
import {
  isOrchestrationProposalActionForScope,
  listOrchestrationProposals,
  type OrchestrationProposal,
} from "./orchestration-proposals.js";
import { acquireSessionLease } from "./session-lease.js";
import { compareByCodePoints } from "@seekforge/shared";

export type OrchestrationDeploymentStatus = "applying" | "applied" | "failed" | "rolled_back" | "superseded";
export type OrchestrationDeploymentVerdict = "pending" | "improved" | "stable" | "regressed";

export type OrchestrationDeploymentMetric = {
  costPerUnit: number;
  durationPerUnitMs: number;
  failures: number;
  terminal: boolean;
};

export type OrchestrationDeployment = {
  proposalId: string;
  proposalUpdatedAt: string;
  scope: "loop" | "graph";
  sourceId: string;
  sourceFingerprint: string;
  action: OrchestrationProposalAction;
  status: OrchestrationDeploymentStatus;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
  targetFingerprint?: string;
  targetStateHash?: string;
  rollbackFingerprint?: string;
  rollbackDefinitionHash?: string;
  rollbackLoopRoute?: AppliedLoopRoute;
  error?: string;
  baseline: OrchestrationDeploymentMetric;
  observed?: OrchestrationDeploymentMetric;
  verdict: OrchestrationDeploymentVerdict;
};

export type ApplyOrchestrationProposalOptions = {
  expectedUpdatedAt?: string;
  executors?: Readonly<Record<string, GraphExecutionAdapter>>;
  faultInjector?: (point: "after_mark_applying" | "after_target_applied") => void;
};

const PATH = ".seekforge/orchestration-deployments.json";
const MAX_BYTES = 256 * 1024;
const MAX_DEPLOYMENTS = 64;
const ID_RE = /^opt-[a-f0-9]{20}$/;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function rollbackPath(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid orchestration proposal id: ${id}`);
  return `.seekforge/orchestration-deployments/${id}.rollback.json`;
}

function validMetric(value: unknown): value is OrchestrationDeploymentMetric {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["costPerUnit", "durationPerUnitMs", "failures", "terminal"]) &&
    typeof value.costPerUnit === "number" &&
    Number.isFinite(value.costPerUnit) &&
    value.costPerUnit >= 0 &&
    Number.isSafeInteger(value.durationPerUnitMs) &&
    (value.durationPerUnitMs as number) >= 0 &&
    Number.isSafeInteger(value.failures) &&
    (value.failures as number) >= 0 &&
    typeof value.terminal === "boolean"
  );
}

function validDeployment(value: unknown): value is OrchestrationDeployment {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "proposalId",
      "proposalUpdatedAt",
      "scope",
      "sourceId",
      "sourceFingerprint",
      "action",
      "status",
      "attempt",
      "startedAt",
      "updatedAt",
      "appliedAt",
      "rolledBackAt",
      "targetFingerprint",
      "targetStateHash",
      "rollbackFingerprint",
      "rollbackDefinitionHash",
      "rollbackLoopRoute",
      "error",
      "baseline",
      "observed",
      "verdict",
    ])
  ) {
    return false;
  }
  const timestamps = [
    value.proposalUpdatedAt,
    value.startedAt,
    value.updatedAt,
    value.appliedAt,
    value.rolledBackAt,
  ].filter((item) => item !== undefined);
  const status = String(value.status);
  const verdict = String(value.verdict);
  const observedTerminal = validMetric(value.observed) ? value.observed.terminal : undefined;
  const observationValid =
    status === "applied"
      ? value.observed === undefined
        ? verdict === "pending"
        : observedTerminal === true
          ? verdict === "improved" || verdict === "stable" || verdict === "regressed"
          : observedTerminal === false && verdict === "pending"
      : status === "rolled_back"
        ? verdict === "stable" || verdict === "regressed"
        : value.observed === undefined && verdict === "pending";
  const lifecycleValid =
    (status === "applying" &&
      value.appliedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.targetFingerprint === undefined &&
      value.targetStateHash === undefined &&
      value.error === undefined &&
      value.observed === undefined &&
      value.verdict === "pending") ||
    (status === "applied" &&
      typeof value.appliedAt === "string" &&
      value.rolledBackAt === undefined &&
      typeof value.targetFingerprint === "string" &&
      value.error === undefined) ||
    (status === "failed" &&
      value.appliedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.targetFingerprint === undefined &&
      value.targetStateHash === undefined &&
      typeof value.error === "string" &&
      value.observed === undefined &&
      value.verdict === "pending") ||
    (status === "rolled_back" &&
      typeof value.appliedAt === "string" &&
      typeof value.rolledBackAt === "string" &&
      typeof value.targetFingerprint === "string" &&
      value.error === undefined) ||
    (status === "superseded" &&
      value.appliedAt === undefined &&
      value.rolledBackAt === undefined &&
      value.targetFingerprint === undefined &&
      value.targetStateHash === undefined &&
      value.observed === undefined &&
      value.verdict === "pending");
  return (
    typeof value.proposalId === "string" &&
    ID_RE.test(value.proposalId) &&
    timestamps.every((item) => typeof item === "string" && Number.isFinite(Date.parse(item))) &&
    (value.scope === "loop" || value.scope === "graph") &&
    typeof value.sourceId === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sourceId) &&
    typeof value.sourceFingerprint === "string" &&
    FINGERPRINT_RE.test(value.sourceFingerprint) &&
    isOrchestrationProposalActionForScope(value.scope, value.action) &&
    ["applying", "applied", "failed", "rolled_back", "superseded"].includes(status) &&
    lifecycleValid &&
    observationValid &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) >= 1 &&
    (value.targetFingerprint === undefined ||
      (typeof value.targetFingerprint === "string" && FINGERPRINT_RE.test(value.targetFingerprint))) &&
    (value.targetStateHash === undefined ||
      (typeof value.targetStateHash === "string" && FINGERPRINT_RE.test(value.targetStateHash))) &&
    (value.rollbackFingerprint === undefined ||
      (typeof value.rollbackFingerprint === "string" && FINGERPRINT_RE.test(value.rollbackFingerprint))) &&
    (value.rollbackDefinitionHash === undefined ||
      (typeof value.rollbackDefinitionHash === "string" && FINGERPRINT_RE.test(value.rollbackDefinitionHash))) &&
    (value.rollbackLoopRoute === undefined || isAppliedLoopRoute(value.rollbackLoopRoute)) &&
    (value.scope === "loop"
      ? value.rollbackFingerprint === undefined &&
        value.rollbackDefinitionHash === undefined &&
        value.targetStateHash === undefined &&
        (value.rollbackLoopRoute === undefined ||
          (value.action.kind === "loop_route" &&
            value.rollbackLoopRoute.loopId === value.sourceId &&
            value.rollbackLoopRoute.failureCategory === value.action.failureCategory &&
            value.rollbackLoopRoute.proposalId !== value.proposalId))
      : value.rollbackLoopRoute === undefined &&
        (status === "applied" || status === "rolled_back"
          ? typeof value.rollbackFingerprint === "string" &&
            typeof value.rollbackDefinitionHash === "string" &&
            typeof value.targetStateHash === "string"
          : (value.rollbackFingerprint === undefined && value.rollbackDefinitionHash === undefined) ||
            (typeof value.rollbackFingerprint === "string" && typeof value.rollbackDefinitionHash === "string"))) &&
    (value.error === undefined ||
      (typeof value.error === "string" && value.error.length > 0 && value.error.length <= 4_096)) &&
    validMetric(value.baseline) &&
    (value.observed === undefined || validMetric(value.observed)) &&
    ["pending", "improved", "stable", "regressed"].includes(verdict) &&
    Date.parse(value.proposalUpdatedAt as string) <= Date.parse(value.startedAt as string) &&
    Date.parse(value.startedAt as string) <= Date.parse(value.updatedAt as string) &&
    (value.appliedAt === undefined || Date.parse(value.startedAt as string) <= Date.parse(value.appliedAt as string)) &&
    (value.appliedAt === undefined || Date.parse(value.appliedAt as string) <= Date.parse(value.updatedAt as string)) &&
    (value.rolledBackAt === undefined ||
      Date.parse(value.appliedAt as string) <= Date.parse(value.rolledBackAt as string)) &&
    (value.rolledBackAt === undefined ||
      Date.parse(value.rolledBackAt as string) <= Date.parse(value.updatedAt as string))
  );
}

function parseDocument(raw: string): OrchestrationDeployment[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "deployments"]) ||
      value.version !== 1 ||
      !isDenseArray(value.deployments) ||
      value.deployments.length > MAX_DEPLOYMENTS ||
      !value.deployments.every(validDeployment) ||
      new Set(value.deployments.map((item) => item.proposalId)).size !== value.deployments.length
    ) {
      return null;
    }
    return value.deployments;
  } catch {
    return null;
  }
}

function readUnlocked(workspace: string, strict = false): OrchestrationDeployment[] {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  if (raw === undefined) return [];
  const parsed = parseDocument(raw);
  if (parsed) return parsed;
  if (strict) throw new Error("Persisted orchestration deployments are invalid");
  return [];
}

function writeUnlocked(workspace: string, deployments: readonly OrchestrationDeployment[]): void {
  const sorted = [...deployments].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      compareByCodePoints(left.proposalId, right.proposalId),
  );
  const active = sorted.filter((deployment) => deployment.status === "applying" || deployment.status === "applied");
  if (active.length > MAX_DEPLOYMENTS) throw new Error("Too many active orchestration deployments");
  const activeIds = new Set(active.map((deployment) => deployment.proposalId));
  const retained = [
    ...active,
    ...sorted.filter((deployment) => !activeIds.has(deployment.proposalId)).slice(0, MAX_DEPLOYMENTS - active.length),
  ];
  const serialized = `${JSON.stringify({ version: 1, deployments: retained })}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES)
    throw new Error("Orchestration deployments exceed the durable byte limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
  const retainedIds = new Set(retained.map((deployment) => deployment.proposalId));
  const root = realpathSync.native(resolve(workspace));
  for (const deployment of deployments) {
    if (deployment.scope !== "graph" || retainedIds.has(deployment.proposalId)) continue;
    const target = resolve(root, rollbackPath(deployment.proposalId));
    try {
      const stat = lstatSync(target, { throwIfNoEntry: false });
      if (
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        realpathSync.native(target) === target &&
        target.startsWith(`${root}${sep}`)
      ) {
        unlinkSync(target);
      }
    } catch {
      // An evicted terminal record no longer relies on its rollback definition.
    }
  }
}

export function listOrchestrationDeployments(workspace: string): OrchestrationDeployment[] {
  const proposals = new Map(listOrchestrationProposals(workspace).map((proposal) => [proposal.id, proposal]));
  return readUnlocked(workspace).map((deployment) => {
    const proposal = proposals.get(deployment.proposalId);
    return proposal &&
      proposal.updatedAt !== deployment.proposalUpdatedAt &&
      deployment.status !== "applying" &&
      deployment.status !== "applied" &&
      deployment.status !== "rolled_back"
      ? { ...deployment, status: "superseded", verdict: "pending" }
      : deployment;
  });
}

function proposalForApply(workspace: string, id: string, expectedUpdatedAt?: string): OrchestrationProposal {
  if (!ID_RE.test(id)) throw new Error(`Invalid orchestration proposal id: ${id}`);
  const proposal = listOrchestrationProposals(workspace).find((item) => item.id === id);
  if (!proposal) throw new Error(`Orchestration proposal not found: ${id}`);
  if (proposal.status !== "approved") throw new Error("Orchestration proposal must be approved before apply");
  if (expectedUpdatedAt !== undefined && proposal.updatedAt !== expectedUpdatedAt) {
    throw new Error("Orchestration proposal changed since it was approved");
  }
  return proposal;
}

function loopMetric(workspace: string, loopId: string): OrchestrationDeploymentMetric {
  const state = loadLoopState(workspace, loopId);
  if (!state) throw new Error(`Persisted Loop not found or invalid: ${loopId}`);
  const units = Math.max(1, state.iterations);
  return {
    costPerUnit: state.costUsd / units,
    durationPerUnitMs: Math.round((state.elapsedMs ?? 0) / units),
    failures: state.lastVerify?.code === 0 ? 0 : (state.snapshots?.at(-1)?.failedTests ?? 1),
    terminal: !["running", "paused", "interrupted", "requirements_pending"].includes(state.status),
  };
}

function graphMetric(workspace: string, graphId: string): OrchestrationDeploymentMetric {
  const state = loadEngineeringGraphState(workspace, graphId);
  if (!state) throw new Error(`Persisted Graph not found or invalid: ${graphId}`);
  const units = Math.max(1, state.results.length);
  return {
    costPerUnit: state.spentCost / units,
    durationPerUnitMs: Math.round(state.elapsedMs / units),
    failures: state.results.filter((result) => result.status === "failed").length,
    terminal: ["passed", "failed", "cancelled"].includes(state.status),
  };
}

function metricForProposal(workspace: string, proposal: Pick<OrchestrationProposal, "scope" | "sourceId">) {
  return proposal.scope === "loop"
    ? loopMetric(workspace, proposal.sourceId)
    : graphMetric(workspace, proposal.sourceId);
}

function writeDeployment(workspace: string, deployment: OrchestrationDeployment): OrchestrationDeployment {
  if (!validDeployment(deployment)) throw new Error("Orchestration deployment is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-deployments");
  try {
    const deployments = readUnlocked(workspace, true);
    const index = deployments.findIndex((item) => item.proposalId === deployment.proposalId);
    if (index >= 0) deployments[index] = deployment;
    else deployments.push(deployment);
    writeUnlocked(workspace, deployments);
    return deployment;
  } finally {
    lease.release();
  }
}

function graphDefinitionForAction(
  definition: EngineeringGraphDefinition,
  action: OrchestrationProposalAction,
  executors: Readonly<Record<string, GraphExecutionAdapter>>,
  validateExecutor = true,
): EngineeringGraphDefinition {
  if (action.kind === "graph_concurrency")
    return parseEngineeringGraphDefinition({ ...definition, maxConcurrency: action.value });
  if (action.kind === "graph_resource_capacity") {
    return parseEngineeringGraphDefinition({
      ...definition,
      resourceCapacities: { ...(definition.resourceCapacities ?? {}), [action.resource]: action.value },
    });
  }
  if (action.kind === "executor_placement") {
    const node = definition.nodes.find((candidate) => candidate.id === action.nodeId);
    if (node?.kind !== "remote") throw new Error(`Graph remote node not found: ${action.nodeId}`);
    if (validateExecutor) {
      const eligibility = graphExecutionAdapterEligibility(node, executors[action.executor]);
      if (eligibility.status !== "eligible") {
        throw new Error(`Graph executor is ineligible: ${eligibility.reasons.join("; ")}`);
      }
    }
    return parseEngineeringGraphDefinition({
      ...definition,
      nodes: definition.nodes.map((candidate) =>
        candidate.id === action.nodeId ? { ...candidate, executor: action.executor } : candidate,
      ),
    });
  }
  throw new Error(`Proposal action cannot mutate a Graph: ${action.kind}`);
}

function rollbackDefinitionHash(definition: EngineeringGraphDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function appliedGraphTarget(
  workspace: string,
  deployment: Pick<
    OrchestrationDeployment,
    "proposalId" | "sourceId" | "action" | "rollbackFingerprint" | "rollbackDefinitionHash"
  >,
): { fingerprint: string; stateHash: string } | undefined {
  try {
    const raw = readWorkspaceStateFile(workspace, rollbackPath(deployment.proposalId), 256 * 1024);
    const current = loadEngineeringGraphState(workspace, deployment.sourceId);
    if (raw === undefined || !current || deployment.rollbackDefinitionHash === undefined) return undefined;
    const source = parseEngineeringGraphDefinition(JSON.parse(raw));
    if (rollbackDefinitionHash(source) !== deployment.rollbackDefinitionHash) return undefined;
    const target = graphDefinitionForAction(source, deployment.action, {}, false);
    const journal = readEngineeringGraphMigrationJournal(workspace, deployment.sourceId);
    const migrated = current.events.at(-1);
    return isDeepStrictEqual(current.definition, target) &&
      deployment.rollbackFingerprint !== undefined &&
      journal !== undefined &&
      journal?.sourceFingerprint === deployment.rollbackFingerprint &&
      journal.targetFingerprint === current.fingerprint &&
      journal.resourceGeneration === current.resourceGeneration &&
      current.status === "paused" &&
      current.pauseReason === "control" &&
      current.controlRunId.startsWith("graph-migration-") &&
      migrated?.type === "graph.migrated" &&
      migrated.timestamp === current.updatedAt
      ? { fingerprint: current.fingerprint, stateHash: graphOrchestrationFingerprint(current) }
      : undefined;
  } catch {
    return undefined;
  }
}

type ApplyingDeploymentReconciliation =
  | { state: "applied"; deployment: OrchestrationDeployment }
  | { state: "not_applied" | "diverged" };

/** Reconciles intent against the exact source, target, or an unsafe third generation. */
function reconcileApplyingDeployment(
  workspace: string,
  deployment: OrchestrationDeployment,
): ApplyingDeploymentReconciliation {
  if (deployment.status !== "applying") return { state: "diverged" };
  const recoveredAt = nextOrchestrationVersion(deployment.updatedAt);
  if (deployment.scope === "loop" && deployment.action.kind === "loop_route") {
    const route = readAppliedLoopRoute(workspace, deployment.sourceId, deployment.action.failureCategory);
    if (route?.proposalId === deployment.proposalId && route.model === deployment.action.model) {
      return {
        state: "applied",
        deployment: writeDeployment(workspace, {
          ...deployment,
          status: "applied",
          appliedAt: recoveredAt,
          updatedAt: recoveredAt,
          targetFingerprint: createHash("sha256").update(JSON.stringify(deployment.action)).digest("hex"),
        }),
      };
    }
    const sourceRouteRestored = deployment.rollbackLoopRoute
      ? isDeepStrictEqual(route, deployment.rollbackLoopRoute)
      : route === undefined;
    return { state: sourceRouteRestored ? "not_applied" : "diverged" };
  }
  if (deployment.scope === "graph") {
    const applied = appliedGraphTarget(workspace, deployment);
    if (applied && deployment.rollbackFingerprint !== undefined) {
      return {
        state: "applied",
        deployment: writeDeployment(workspace, {
          ...deployment,
          status: "applied",
          appliedAt: recoveredAt,
          updatedAt: recoveredAt,
          targetFingerprint: applied.fingerprint,
          targetStateHash: applied.stateHash,
          rollbackFingerprint: deployment.rollbackFingerprint,
        }),
      };
    }
    try {
      const current = loadEngineeringGraphState(workspace, deployment.sourceId);
      if (deployment.rollbackFingerprint === undefined && deployment.rollbackDefinitionHash === undefined) {
        return {
          state:
            current !== null && graphOrchestrationFingerprint(current) === deployment.sourceFingerprint
              ? "not_applied"
              : "diverged",
        };
      }
      const raw = readWorkspaceStateFile(workspace, rollbackPath(deployment.proposalId), 256 * 1024);
      const source = raw === undefined ? undefined : parseEngineeringGraphDefinition(JSON.parse(raw));
      const sourceIsExact =
        current !== null &&
        source !== undefined &&
        deployment.rollbackDefinitionHash !== undefined &&
        rollbackDefinitionHash(source) === deployment.rollbackDefinitionHash &&
        isDeepStrictEqual(current.definition, source) &&
        graphOrchestrationFingerprint(current) === deployment.sourceFingerprint;
      return { state: sourceIsExact ? "not_applied" : "diverged" };
    } catch {
      return { state: "diverged" };
    }
  }
  return { state: "diverged" };
}

function applyOrchestrationProposalUnlocked(
  workspace: string,
  id: string,
  options: ApplyOrchestrationProposalOptions = {},
): OrchestrationDeployment {
  const proposal = proposalForApply(workspace, id, options.expectedUpdatedAt);
  const deployments = readUnlocked(workspace, true);
  const existing = deployments.find((item) => item.proposalId === id);
  if (existing?.status === "applied" && existing.proposalUpdatedAt === proposal.updatedAt) return existing;
  if (existing?.status === "applied") {
    throw new Error("Rollback the existing applied deployment before applying the updated proposal");
  }
  const activeConflict = deployments.find(
    (deployment) =>
      deployment.proposalId !== proposal.id &&
      deployment.status === "applied" &&
      deployment.scope === proposal.scope &&
      deployment.sourceId === proposal.sourceId &&
      (proposal.scope === "graph" ||
        (deployment.action.kind === "loop_route" &&
          proposal.action.kind === "loop_route" &&
          deployment.action.failureCategory === proposal.action.failureCategory)),
  );
  if (activeConflict) {
    throw new Error(`Rollback the active target deployment before applying proposal ${proposal.id}`);
  }
  if (existing?.status === "applying") {
    const reconciliation = reconcileApplyingDeployment(workspace, existing);
    if (reconciliation.state === "applied") {
      if (existing.proposalUpdatedAt === proposal.updatedAt) return reconciliation.deployment;
      throw new Error("Rollback the recovered applied deployment before applying the updated proposal");
    }
    if (reconciliation.state === "diverged") {
      throw new Error("Orchestration deployment target diverged while applying; manual recovery is required");
    }
    if (existing.proposalUpdatedAt !== proposal.updatedAt) {
      writeDeployment(workspace, {
        ...existing,
        status: "superseded",
        updatedAt: nextOrchestrationVersion(existing.updatedAt),
      });
    }
  }
  if (proposal.action.kind === "budget_review") {
    throw new Error(
      "Budget review proposals require an explicit Loop resume budget extension and cannot be auto-applied",
    );
  }
  const rollbackLoopRoute =
    proposal.scope === "loop" && proposal.action.kind === "loop_route"
      ? readAppliedLoopRoute(workspace, proposal.sourceId, proposal.action.failureCategory)
      : undefined;
  const now = nextOrchestrationVersion(proposal.updatedAt);
  let applying: OrchestrationDeployment = {
    proposalId: proposal.id,
    proposalUpdatedAt: proposal.updatedAt,
    scope: proposal.scope,
    sourceId: proposal.sourceId,
    sourceFingerprint: proposal.sourceFingerprint,
    action: proposal.action,
    status: "applying",
    attempt: (existing?.attempt ?? 0) + 1,
    startedAt: now,
    updatedAt: now,
    baseline: metricForProposal(workspace, proposal),
    verdict: "pending",
    ...(rollbackLoopRoute ? { rollbackLoopRoute } : {}),
  };
  writeDeployment(workspace, applying);
  options.faultInjector?.("after_mark_applying");
  let effectCommitted = false;
  try {
    let targetFingerprint: string;
    let targetStateHash: string | undefined;
    let rollbackFingerprint: string | undefined;
    if (proposal.scope === "loop") {
      const state = loadLoopState(workspace, proposal.sourceId);
      if (!state || loopOrchestrationFingerprint(state) !== proposal.sourceFingerprint) {
        throw new Error("Loop proposal source generation is stale");
      }
      if (proposal.action.kind !== "loop_route") throw new Error("Loop proposal action is not deployable");
      applyLoopRoutePolicy(workspace, {
        loopId: proposal.sourceId,
        failureCategory: proposal.action.failureCategory,
        model: proposal.action.model,
        proposalId: proposal.id,
        appliedAt: now,
      });
      targetFingerprint = createHash("sha256").update(JSON.stringify(proposal.action)).digest("hex");
    } else {
      const state = loadEngineeringGraphState(workspace, proposal.sourceId);
      if (!state || graphOrchestrationFingerprint(state) !== proposal.sourceFingerprint)
        throw new Error("Graph proposal source generation is stale");
      const target = graphDefinitionForAction(state.definition, proposal.action, options.executors ?? {});
      rollbackFingerprint = state.fingerprint;
      writeWorkspaceStateFileAtomic(workspace, rollbackPath(proposal.id), `${JSON.stringify(state.definition)}\n`);
      applying = writeDeployment(workspace, {
        ...applying,
        rollbackFingerprint,
        rollbackDefinitionHash: rollbackDefinitionHash(state.definition),
        updatedAt: nextOrchestrationVersion(applying.updatedAt),
      });
      const migrated = applyEngineeringGraphMigration(workspace, target).state;
      targetFingerprint = migrated.fingerprint;
      targetStateHash = graphOrchestrationFingerprint(migrated);
    }
    effectCommitted = true;
    options.faultInjector?.("after_target_applied");
    const appliedAt = nextOrchestrationVersion(applying.updatedAt);
    return writeDeployment(workspace, {
      ...applying,
      status: "applied",
      updatedAt: appliedAt,
      appliedAt,
      targetFingerprint,
      ...(targetStateHash ? { targetStateHash } : {}),
      ...(rollbackFingerprint ? { rollbackFingerprint } : {}),
    });
  } catch (error) {
    if (effectCommitted) throw error;
    if (proposal.scope === "graph" && appliedGraphTarget(workspace, applying)) throw error;
    const updatedAt = nextOrchestrationVersion(applying.updatedAt);
    writeDeployment(workspace, {
      ...applying,
      status: "failed",
      updatedAt,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Deployment failed",
    });
    throw error;
  }
}

export function applyOrchestrationProposal(
  workspace: string,
  id: string,
  options: ApplyOrchestrationProposalOptions = {},
): OrchestrationDeployment {
  if (!ID_RE.test(id)) throw new Error(`Invalid orchestration proposal id: ${id}`);
  const lease = acquireSessionLease(workspace, `orchestration-deploy-${id}`);
  try {
    const proposal = proposalForApply(workspace, id, options.expectedUpdatedAt);
    const targetLease = acquireSessionLease(workspace, orchestrationTargetLeaseId(proposal.scope, proposal.sourceId));
    let loopLease: ReturnType<typeof acquireLoopLifecycleLease> | undefined;
    try {
      if (proposal.scope === "loop") loopLease = acquireLoopLifecycleLease(workspace, proposal.sourceId);
      const current = proposalForApply(workspace, id, options.expectedUpdatedAt);
      if (current.scope !== proposal.scope || current.sourceId !== proposal.sourceId) {
        throw new Error("Orchestration proposal target changed before apply");
      }
      return applyOrchestrationProposalUnlocked(workspace, id, options);
    } finally {
      loopLease?.release();
      targetLease.release();
    }
  } finally {
    lease.release();
  }
}

function deploymentVerdict(
  baseline: OrchestrationDeploymentMetric,
  observed: OrchestrationDeploymentMetric,
): OrchestrationDeploymentVerdict {
  if (!observed.terminal) return "pending";
  const failureDelta = observed.failures - baseline.failures;
  const costRatio = baseline.costPerUnit === 0 ? 1 : observed.costPerUnit / baseline.costPerUnit;
  const durationRatio = baseline.durationPerUnitMs === 0 ? 1 : observed.durationPerUnitMs / baseline.durationPerUnitMs;
  if (failureDelta > 0 || costRatio > 1.15 || durationRatio > 1.15) return "regressed";
  if (failureDelta < 0 || costRatio < 0.9 || durationRatio < 0.9) return "improved";
  return "stable";
}

export function observeOrchestrationDeployments(
  workspace: string,
  options: { autoRollback?: boolean } = {},
): OrchestrationDeployment[] {
  const proposals = new Map(listOrchestrationProposals(workspace).map((proposal) => [proposal.id, proposal]));
  const observed: OrchestrationDeployment[] = [];
  const ids = readUnlocked(workspace, true).map((deployment) => deployment.proposalId);
  for (const proposalId of ids) {
    const deploymentLease = acquireSessionLease(workspace, `orchestration-deploy-${proposalId}`);
    try {
      const deployment = readUnlocked(workspace, true).find((item) => item.proposalId === proposalId);
      if (!deployment) continue;
      const reconciliation = reconcileApplyingDeployment(workspace, deployment);
      if (reconciliation.state === "applied") {
        observed.push(reconciliation.deployment);
        continue;
      }
      if (deployment.status === "applying" && reconciliation.state === "diverged") {
        observed.push(deployment);
        continue;
      }
      const proposal = proposals.get(deployment.proposalId);
      if (
        proposal &&
        proposal.updatedAt !== deployment.proposalUpdatedAt &&
        deployment.status !== "applied" &&
        deployment.status !== "rolled_back"
      ) {
        observed.push(
          writeDeployment(workspace, {
            ...deployment,
            status: "superseded",
            updatedAt: nextOrchestrationVersion(deployment.updatedAt),
          }),
        );
        continue;
      }
      if (deployment.status !== "applied") {
        observed.push(deployment);
        continue;
      }
      const targetLease = acquireSessionLease(
        workspace,
        orchestrationTargetLeaseId(deployment.scope, deployment.sourceId),
      );
      try {
        const current = readUnlocked(workspace, true).find((item) => item.proposalId === proposalId);
        if (current?.status !== "applied") {
          if (current) observed.push(current);
          continue;
        }
        const metric = metricForProposal(workspace, current);
        const verdict = deploymentVerdict(current.baseline, metric);
        const next = writeDeployment(workspace, {
          ...current,
          observed: metric,
          verdict,
          updatedAt: nextOrchestrationVersion(current.updatedAt),
        });
        observed.push(
          verdict === "regressed" && options.autoRollback
            ? rollbackOrchestrationDeploymentUnlocked(workspace, proposalId)
            : next,
        );
      } finally {
        targetLease.release();
      }
    } finally {
      deploymentLease.release();
    }
  }
  return observed;
}

function rollbackOrchestrationDeploymentUnlocked(workspace: string, proposalId: string): OrchestrationDeployment {
  const deployment = readUnlocked(workspace, true).find((item) => item.proposalId === proposalId);
  if (!deployment) throw new Error(`Orchestration deployment not found: ${proposalId}`);
  if (deployment.status === "rolled_back") return deployment;
  if (deployment.status !== "applied") throw new Error("Only an applied orchestration deployment can be rolled back");
  if (deployment.scope === "loop") {
    if (deployment.action.kind !== "loop_route") throw new Error("Loop deployment action is invalid");
    const currentRoute = readAppliedLoopRoute(workspace, deployment.sourceId, deployment.action.failureCategory);
    const alreadyRestored = deployment.rollbackLoopRoute
      ? isDeepStrictEqual(currentRoute, deployment.rollbackLoopRoute)
      : currentRoute === undefined;
    if (!alreadyRestored) {
      if (currentRoute?.proposalId !== proposalId) {
        throw new Error("Loop route changed after deployment; automatic rollback is no longer safe");
      }
      rollbackLoopRoutePolicy(workspace, proposalId, deployment.rollbackLoopRoute);
    }
  } else {
    const state = loadEngineeringGraphState(workspace, deployment.sourceId);
    if (!state) throw new Error("Graph changed after deployment; automatic rollback is no longer safe");
    const raw = readWorkspaceStateFile(workspace, rollbackPath(proposalId), 256 * 1024);
    if (raw === undefined) throw new Error("Graph rollback definition is missing");
    const definition = parseEngineeringGraphDefinition(JSON.parse(raw));
    if (
      deployment.rollbackDefinitionHash === undefined ||
      rollbackDefinitionHash(definition) !== deployment.rollbackDefinitionHash
    ) {
      throw new Error("Graph rollback definition changed after deployment");
    }
    if (definition.graphId !== deployment.sourceId || definition.graphId !== state.graphId) {
      throw new Error("Graph rollback definition does not match the deployment");
    }
    const alreadyRestored =
      deployment.rollbackFingerprint !== undefined &&
      state.fingerprint === deployment.rollbackFingerprint &&
      isDeepStrictEqual(definition, state.definition);
    if (!alreadyRestored) {
      if (
        state.fingerprint !== deployment.targetFingerprint ||
        graphOrchestrationFingerprint(state) !== deployment.targetStateHash
      ) {
        throw new Error("Graph changed after deployment; automatic rollback is no longer safe");
      }
      if (deployment.rollbackFingerprint && isDeepStrictEqual(definition, state.definition)) {
        throw new Error("Graph rollback definition unexpectedly matches the deployed definition");
      }
      applyEngineeringGraphMigration(workspace, definition);
    }
  }
  const rolledBackAt = nextOrchestrationVersion(deployment.updatedAt);
  return writeDeployment(workspace, {
    ...deployment,
    status: "rolled_back",
    verdict: deployment.verdict === "regressed" ? "regressed" : "stable",
    updatedAt: rolledBackAt,
    rolledBackAt,
  });
}

export function rollbackOrchestrationDeployment(workspace: string, proposalId: string): OrchestrationDeployment {
  if (!ID_RE.test(proposalId)) throw new Error(`Invalid orchestration proposal id: ${proposalId}`);
  const lease = acquireSessionLease(workspace, `orchestration-deploy-${proposalId}`);
  try {
    const deployment = readUnlocked(workspace, true).find((item) => item.proposalId === proposalId);
    if (!deployment) throw new Error(`Orchestration deployment not found: ${proposalId}`);
    const targetLease = acquireSessionLease(
      workspace,
      orchestrationTargetLeaseId(deployment.scope, deployment.sourceId),
    );
    let loopLease: ReturnType<typeof acquireLoopLifecycleLease> | undefined;
    try {
      if (deployment.scope === "loop") loopLease = acquireLoopLifecycleLease(workspace, deployment.sourceId);
      return rollbackOrchestrationDeploymentUnlocked(workspace, proposalId);
    } finally {
      loopLease?.release();
      targetLease.release();
    }
  } finally {
    lease.release();
  }
}

function orchestrationTargetLeaseId(scope: "loop" | "graph", sourceId: string): string {
  const digest = createHash("sha256").update(`${scope}\0${sourceId}`).digest("hex").slice(0, 32);
  return `orchestration-target-${scope}-${digest}`;
}
