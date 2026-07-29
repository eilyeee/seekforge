import { randomUUID } from "node:crypto";
import type { AgentError, LoopDeliverySummary, LoopPersistedStatus } from "@seekforge/shared";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LoopIterationSnapshot, LoopStageResult, LoopVerificationStage } from "./auto-loop.js";
import {
  DEFAULT_LOOP_AGENT_RETRIES,
  DEFAULT_LOOP_AGENT_TIMEOUT_MS,
  DEFAULT_LOOP_VERIFY_TIMEOUT_MS,
  MAX_LOOP_ITERATIONS,
  MAX_LOOP_LOG_SEGMENTS,
} from "./loop-constants.js";
import { resolveForWrite } from "../tools/sandbox.js";
import { FileTooLargeError } from "../util/fs.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isRecord } from "../util/guards.js";
import { isDenseArray } from "./orchestration.js";
import {
  isLoopRequirementMode,
  parseLoopAcceptanceReview,
  parseLoopRequirementSpec,
  type LoopAcceptanceReview,
  type LoopRequirementMode,
  type LoopRequirementSpec,
} from "./loop-requirements.js";
import { acquireWorkspaceSessionGuard, type SessionLease } from "./session-lease.js";
import {
  LOOP_ID_RE,
  isValidLoopId,
  loopLogFile,
  loopStateFile as loopFile,
  loopStateRoot as loopsRoot,
  requireLoopWorkspace as requireWorkspace,
} from "./loop-state-paths.js";
import {
  acquireLoopLease,
  acquireLoopLifecycleLease,
  isLoopDeliveryActive,
  isLoopLeaseActive,
  isLoopLifecycleActive,
  type LoopLease,
} from "./loop-lease.js";

export { appendLoopLog, createLoopLogWriter, readLoopHistory } from "./loop-history.js";
export type { LoopHistoryEntry, LoopLogWriter } from "./loop-history.js";
export {
  acquireLoopDeliveryLease,
  acquireLoopLease,
  acquireLoopLifecycleLease,
  acquireLoopLifecycleLeaseWithPreemption,
  hasActiveLoopLease,
  isLoopDeliveryActive,
  isLoopLeaseActive,
  isLoopLifecycleActive,
} from "./loop-lease.js";
export type { LoopLease } from "./loop-lease.js";
export { isValidLoopId } from "./loop-state-paths.js";

export type PersistedLoopStatus = LoopPersistedStatus;
export type LoopVerifyResult = { code: number; output: string };
export type LoopDeliveryMode = LoopDeliverySummary["mode"];
export type LoopDeliveryStatus = LoopDeliverySummary["status"];
export type LoopDeliveryPhase = NonNullable<LoopDeliverySummary["phase"]>;
export type LoopDeliveryEvidence = NonNullable<LoopDeliverySummary["evidence"]>;
export type LoopDeliveryCiState = NonNullable<LoopDeliverySummary["ci"]>;
export type LoopDeliveryState = LoopDeliverySummary;

/** True only when a delivery artifact has the evidence required by its mode. */
export function hasCompleteLoopDeliveryEvidence(
  mode: LoopDeliveryMode,
  artifact: string,
  evidence: LoopDeliveryEvidence | undefined,
): evidence is LoopDeliveryEvidence {
  if (!evidence?.branch || !evidence.revision || !/^[0-9a-fA-F]{40,64}$/.test(evidence.revision)) return false;
  if (mode === "checkpoint" || mode === "merge") return artifact === evidence.branch;
  if (mode === "patch") return typeof evidence.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(evidence.sha256);
  return typeof evidence.url === "string" && evidence.url === artifact;
}
export type LoopRecoveryMetadata = {
  attempts: number;
  lastAttemptAt: string;
  nextAttemptAt?: string;
  lastError?: string;
};
export type LoopPruneOptions = {
  /** Remove eligible terminal records older than this many days. */
  maxAgeDays?: number;
  /** Keep at most this many eligible terminal records, newest first. */
  maxTerminalCount?: number;
  dryRun?: boolean;
  now?: Date;
  /** Internal capability for cleanup running under the idle workspace guard. */
  workspaceGuard?: SessionLease;
};
export type LoopPruneResult = { candidates: string[]; removed: string[]; skipped: string[] };
export type LoopState = {
  schemaVersion?: 2;
  loopId: string;
  task: string;
  workspace: string;
  verifyCommand: string;
  verificationPlan?: LoopVerificationStage[];
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  adaptiveBudget?: boolean;
  passStreak?: number;
  recoveryAttempts?: number;
  controlSeq?: number;
  controlRunId?: string;
  delivery?: LoopDeliveryState;
  priority?: number;
  recovery?: LoopRecoveryMetadata;
  stageResults?: LoopStageResult[];
  snapshots?: LoopIterationSnapshot[];
  maxIterations: number;
  costBudgetUsd: number | null;
  tokenBudget?: number | null;
  maxDurationMs?: number | null;
  maxVerifyRuns?: number | null;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  iterations: number;
  costUsd: number;
  tokensUsed?: number;
  verifyRuns?: number;
  elapsedMs?: number;
  sessionId: string;
  reviewerSessionId?: string;
  lastVerify: LoopVerifyResult | null;
  lastAgentError?: AgentError | null;
  /** Optional in the type so callers can still represent legacy persisted records. */
  requirementMode?: LoopRequirementMode;
  requirements?: LoopRequirementSpec | null;
  acceptanceReview?: LoopAcceptanceReview | null;
  requirementsApprovedAt?: string | null;
  status: PersistedLoopStatus;
  createdAt: string;
  updatedAt: string;
};
export type CreateLoopStateInput = Pick<LoopState, "task" | "workspace" | "verifyCommand" | "maxIterations"> & {
  loopId?: string;
  costBudgetUsd?: number | null;
  tokenBudget?: number | null;
  maxDurationMs?: number | null;
  maxVerifyRuns?: number | null;
  verifyTimeoutMs?: number;
  agentTimeoutMs?: number;
  maxAgentRetries?: number;
  sessionId?: string;
  lastVerify?: LoopVerifyResult | null;
  requirementMode?: LoopRequirementMode;
  verificationPlan?: LoopVerificationStage[];
  stablePasses?: number;
  flakyRetries?: number;
  maxNoProgressRecoveries?: number;
  rollbackOnRegression?: boolean;
  adaptiveBudget?: boolean;
  controlRunId?: string;
  priority?: number;
};

const LOOP_DELIVERY_MODES = new Set<LoopDeliveryMode>(["checkpoint", "merge", "patch", "pr"]);
const LOOP_DELIVERY_STATUSES = new Set<LoopDeliveryStatus>(["running", "delivered", "failed"]);
const LOOP_DELIVERY_PHASES = new Set<LoopDeliveryPhase>(["prepared", "action_completed", "finalized"]);
const MAX_LOOP_DELIVERY_DETAIL_LENGTH = 8_192;
const MAX_LOOP_STATE_BYTES = 1024 * 1024;
const LOOP_STATUSES = new Set<PersistedLoopStatus>([
  "running",
  "paused",
  "passed",
  "exhausted",
  "no_progress",
  "budget",
  "cancelled",
  "verify_error",
  "agent_error",
  "interrupted",
  "requirements_pending",
]);

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isSafeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isIsoDate = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

function compactLoopSnapshots(state: LoopState): LoopState {
  if (!state.snapshots?.length) return state;
  return {
    ...state,
    snapshots: state.snapshots.map((snapshot) => ({
      ...snapshot,
      stageResults: snapshot.stageResults.map((stage) => ({ ...stage, command: "", output: "" })),
    })),
  };
}

function parseVerificationPlan(value: unknown): LoopVerificationStage[] | null {
  if (!isDenseArray(value) || value.length === 0 || value.length > 16) return null;
  const ids = new Set<string>();
  const result: LoopVerificationStage[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      !LOOP_ID_RE.test(item.id) ||
      ids.has(item.id) ||
      typeof item.command !== "string" ||
      item.command.trim() === "" ||
      item.command.length > 8_192 ||
      (item.required !== undefined && typeof item.required !== "boolean") ||
      (item.cacheable !== undefined && typeof item.cacheable !== "boolean") ||
      (item.parallel !== undefined && typeof item.parallel !== "boolean") ||
      (item.resources !== undefined &&
        (!isDenseArray(item.resources) ||
          item.resources.length === 0 ||
          item.resources.length > 16 ||
          new Set(item.resources).size !== item.resources.length ||
          item.resources.some(
            (resource) => typeof resource !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(resource),
          ))) ||
      (item.parallel === true && !isDenseArray(item.resources)) ||
      (item.dependsOn !== undefined &&
        (!isDenseArray(item.dependsOn) ||
          item.dependsOn.length === 0 ||
          item.dependsOn.length > 15 ||
          new Set(item.dependsOn).size !== item.dependsOn.length ||
          item.dependsOn.some((id) => typeof id !== "string" || !LOOP_ID_RE.test(id)))) ||
      (item.dependencyPaths !== undefined &&
        (!isDenseArray(item.dependencyPaths) ||
          item.dependencyPaths.length === 0 ||
          item.dependencyPaths.length > 64 ||
          !item.dependencyPaths.every((path) => isDenseArray(item.paths) && item.paths.includes(path)))) ||
      (item.timeoutMs !== undefined && (!isSafeInteger(item.timeoutMs) || item.timeoutMs <= 0)) ||
      (item.paths !== undefined &&
        (!isDenseArray(item.paths) ||
          item.paths.length === 0 ||
          item.paths.length > 64 ||
          !item.paths.every(
            (path) =>
              typeof path === "string" &&
              path.length > 0 &&
              path.length <= 512 &&
              !path.includes("\0") &&
              !path.startsWith("/") &&
              !/^[A-Za-z]:[\\/]/.test(path) &&
              !path
                .replaceAll("\\", "/")
                .split("/")
                .some((part) => part === "" || part === "." || part === ".."),
          )))
    )
      return null;
    ids.add(item.id);
    result.push({
      id: item.id,
      command: item.command,
      ...(typeof item.required === "boolean" ? { required: item.required } : {}),
      ...(typeof item.timeoutMs === "number" ? { timeoutMs: item.timeoutMs } : {}),
      ...(isDenseArray(item.paths) ? { paths: item.paths as string[] } : {}),
      ...(isDenseArray(item.dependencyPaths) ? { dependencyPaths: item.dependencyPaths as string[] } : {}),
      ...(typeof item.cacheable === "boolean" ? { cacheable: item.cacheable } : {}),
      ...(isDenseArray(item.dependsOn) ? { dependsOn: item.dependsOn as string[] } : {}),
      ...(typeof item.parallel === "boolean" ? { parallel: item.parallel } : {}),
      ...(isDenseArray(item.resources) ? { resources: item.resources as string[] } : {}),
    });
  }
  const known = new Set(result.map((stage) => stage.id));
  const remaining = new Map(result.map((stage) => [stage.id, new Set(stage.dependsOn ?? [])]));
  for (const stage of result) {
    if (stage.dependsOn?.some((id) => id === stage.id || !known.has(id))) return null;
  }
  const ready = [...remaining].filter(([, dependencies]) => dependencies.size === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    remaining.delete(id);
    visited++;
    for (const [candidate, dependencies] of remaining) {
      if (dependencies.delete(id) && dependencies.size === 0) ready.push(candidate);
    }
  }
  if (visited !== result.length) return null;
  return result;
}

function parseStageResults(value: unknown): LoopStageResult[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const result: LoopStageResult[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.command !== "string" ||
      !isFiniteNumber(item.code) ||
      !Number.isInteger(item.code) ||
      typeof item.output !== "string" ||
      !isSafeInteger(item.attempts) ||
      item.attempts <= 0 ||
      typeof item.flaky !== "boolean" ||
      !isSafeInteger(item.durationMs) ||
      item.durationMs < 0 ||
      (item.selection !== undefined &&
        item.selection !== "full" &&
        item.selection !== "direct" &&
        item.selection !== "dependency" &&
        item.selection !== "cached") ||
      (item.matchedPaths !== undefined &&
        (!Array.isArray(item.matchedPaths) ||
          item.matchedPaths.length > 16 ||
          item.matchedPaths.some((path) => typeof path !== "string" || path.length > 512)))
    )
      return null;
    result.push(item as LoopStageResult);
  }
  return result;
}

function parseSnapshots(value: unknown): LoopIterationSnapshot[] | null {
  if (!Array.isArray(value) || value.length > MAX_LOOP_ITERATIONS) return null;
  const result: LoopIterationSnapshot[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isSafeInteger(item.iteration) ||
      item.iteration < 0 ||
      !isIsoDate(item.ts) ||
      typeof item.diagnosticsFingerprint !== "string" ||
      (item.workspaceFingerprint !== null && typeof item.workspaceFingerprint !== "string") ||
      !isSafeInteger(item.failedTests) ||
      item.failedTests < 0 ||
      (item.durationMs !== undefined && (!isSafeInteger(item.durationMs) || item.durationMs < 0)) ||
      (item.costUsd !== undefined && (!isFiniteNumber(item.costUsd) || item.costUsd < 0)) ||
      (item.tokensUsed !== undefined && (!isSafeInteger(item.tokensUsed) || item.tokensUsed < 0)) ||
      (item.changedPaths !== undefined &&
        (!Array.isArray(item.changedPaths) ||
          item.changedPaths.length > 128 ||
          item.changedPaths.some(
            (path) =>
              typeof path !== "string" ||
              path.length === 0 ||
              path.length > 1_024 ||
              path.includes("\0") ||
              path.startsWith("/") ||
              /^[A-Za-z]:[\\/]/.test(path) ||
              path
                .replaceAll("\\", "/")
                .split("/")
                .some((part) => part === "" || part === "." || part === ".."),
          ))) ||
      (item.failureCategory !== undefined &&
        item.failureCategory !== "none" &&
        item.failureCategory !== "test" &&
        item.failureCategory !== "compile" &&
        item.failureCategory !== "lint" &&
        item.failureCategory !== "review" &&
        item.failureCategory !== "environment" &&
        item.failureCategory !== "timeout" &&
        item.failureCategory !== "permission" &&
        item.failureCategory !== "network" &&
        item.failureCategory !== "unknown") ||
      (item.rolledBack !== undefined && typeof item.rolledBack !== "boolean")
    )
      return null;
    const stageResults = parseStageResults(item.stageResults);
    if (stageResults === null) return null;
    result.push({
      iteration: item.iteration,
      ts: item.ts,
      diagnosticsFingerprint: item.diagnosticsFingerprint,
      workspaceFingerprint: item.workspaceFingerprint,
      failedTests: item.failedTests,
      stageResults,
      ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
      ...(typeof item.costUsd === "number" ? { costUsd: item.costUsd } : {}),
      ...(typeof item.tokensUsed === "number" ? { tokensUsed: item.tokensUsed } : {}),
      ...(Array.isArray(item.changedPaths) ? { changedPaths: item.changedPaths as string[] } : {}),
      ...(typeof item.failureCategory === "string"
        ? { failureCategory: item.failureCategory as LoopIterationSnapshot["failureCategory"] }
        : {}),
      ...(typeof item.rolledBack === "boolean" ? { rolledBack: item.rolledBack } : {}),
    });
  }
  return result;
}

function parseDelivery(value: unknown): LoopDeliveryState | null {
  const phase =
    typeof (value as { phase?: unknown })?.phase === "string"
      ? ((value as { phase: string }).phase as LoopDeliveryPhase)
      : isRecord(value) && value.status === "delivered"
        ? "action_completed"
        : "prepared";
  const evidenceValue = isRecord(value) ? value.evidence : undefined;
  const ciValue = isRecord(value) ? value.ci : undefined;
  if (
    !isRecord(value) ||
    typeof value.mode !== "string" ||
    !LOOP_DELIVERY_MODES.has(value.mode as LoopDeliveryMode) ||
    typeof value.status !== "string" ||
    !LOOP_DELIVERY_STATUSES.has(value.status as LoopDeliveryStatus) ||
    !LOOP_DELIVERY_PHASES.has(phase) ||
    !isSafeInteger(value.attempts) ||
    value.attempts <= 0 ||
    !isIsoDate(value.updatedAt) ||
    (value.artifact !== undefined &&
      (typeof value.artifact !== "string" ||
        value.artifact.trim() === "" ||
        value.artifact.length > MAX_LOOP_DELIVERY_DETAIL_LENGTH)) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" ||
        value.error.trim() === "" ||
        value.error.length > MAX_LOOP_DELIVERY_DETAIL_LENGTH)) ||
    (evidenceValue !== undefined &&
      (!isRecord(evidenceValue) ||
        ![evidenceValue.branch, evidenceValue.revision, evidenceValue.sha256, evidenceValue.url].every(
          (item) => item === undefined || (typeof item === "string" && item.length > 0 && item.length <= 8_192),
        ))) ||
    (ciValue !== undefined &&
      (!isRecord(ciValue) ||
        ciValue.required !== true ||
        !isSafeInteger(ciValue.maxRepairs) ||
        ciValue.maxRepairs < 0 ||
        ciValue.maxRepairs > 3 ||
        !isSafeInteger(ciValue.repairAttempts) ||
        ciValue.repairAttempts < 0 ||
        ciValue.repairAttempts > ciValue.maxRepairs ||
        !isFiniteNumber(ciValue.repairBudgetUsd) ||
        ciValue.repairBudgetUsd <= 0 ||
        (ciValue.status !== "pending" && ciValue.status !== "passed" && ciValue.status !== "failed") ||
        !isIsoDate(ciValue.updatedAt) ||
        (ciValue.revision !== undefined &&
          (typeof ciValue.revision !== "string" || !/^[0-9a-fA-F]{40,64}$/.test(ciValue.revision))) ||
        (ciValue.url !== undefined &&
          (typeof ciValue.url !== "string" || ciValue.url.length === 0 || ciValue.url.length > 8_192)) ||
        (ciValue.error !== undefined &&
          (typeof ciValue.error !== "string" || ciValue.error.length === 0 || ciValue.error.length > 8_192)))) ||
    (phase === "prepared" && (value.artifact !== undefined || evidenceValue !== undefined)) ||
    (phase !== "prepared" && value.artifact === undefined) ||
    (value.status === "running" && value.error !== undefined) ||
    (value.status === "delivered" && (value.artifact === undefined || value.error !== undefined)) ||
    (value.status === "failed" && value.error === undefined) ||
    (phase === "finalized" && value.status !== "delivered") ||
    (value.status === "delivered" && isRecord(ciValue) && ciValue.status !== "passed")
  )
    return null;
  const evidence = isRecord(evidenceValue)
    ? {
        ...(typeof evidenceValue.branch === "string" ? { branch: evidenceValue.branch } : {}),
        ...(typeof evidenceValue.revision === "string" ? { revision: evidenceValue.revision } : {}),
        ...(typeof evidenceValue.sha256 === "string" ? { sha256: evidenceValue.sha256 } : {}),
        ...(typeof evidenceValue.url === "string" ? { url: evidenceValue.url } : {}),
      }
    : undefined;
  const ci = isRecord(ciValue)
    ? {
        required: true as const,
        maxRepairs: ciValue.maxRepairs as number,
        repairAttempts: ciValue.repairAttempts as number,
        repairBudgetUsd: ciValue.repairBudgetUsd as number,
        status: ciValue.status as LoopDeliveryCiState["status"],
        updatedAt: ciValue.updatedAt as string,
        ...(typeof ciValue.revision === "string" ? { revision: ciValue.revision } : {}),
        ...(typeof ciValue.url === "string" ? { url: ciValue.url } : {}),
        ...(typeof ciValue.error === "string" ? { error: ciValue.error } : {}),
      }
    : undefined;
  const normalizedPhase =
    phase === "finalized" &&
    typeof value.artifact === "string" &&
    !hasCompleteLoopDeliveryEvidence(value.mode as LoopDeliveryMode, value.artifact, evidence)
      ? "action_completed"
      : phase;
  return {
    mode: value.mode as LoopDeliveryMode,
    status: value.status as LoopDeliveryStatus,
    phase: normalizedPhase,
    attempts: value.attempts,
    updatedAt: value.updatedAt,
    ...(typeof value.artifact === "string" ? { artifact: value.artifact } : {}),
    ...(evidence ? { evidence } : {}),
    ...(ci ? { ci } : {}),
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function parseLoopState(value: unknown, expectedWorkspace?: string): LoopState | null {
  if (!isRecord(value)) return null;
  const budget = value.costBudgetUsd;
  const tokenBudget = value.tokenBudget === undefined ? null : value.tokenBudget;
  const maxDurationMs = value.maxDurationMs === undefined ? null : value.maxDurationMs;
  const maxVerifyRuns = value.maxVerifyRuns === undefined ? null : value.maxVerifyRuns;
  const verifyTimeoutMs = value.verifyTimeoutMs === undefined ? DEFAULT_LOOP_VERIFY_TIMEOUT_MS : value.verifyTimeoutMs;
  const agentTimeoutMs = value.agentTimeoutMs === undefined ? DEFAULT_LOOP_AGENT_TIMEOUT_MS : value.agentTimeoutMs;
  const maxAgentRetries = value.maxAgentRetries === undefined ? DEFAULT_LOOP_AGENT_RETRIES : value.maxAgentRetries;
  const tokensUsed = value.tokensUsed === undefined ? 0 : value.tokensUsed;
  const verifyRuns = value.verifyRuns === undefined ? 0 : value.verifyRuns;
  const elapsedMs = value.elapsedMs === undefined ? 0 : value.elapsedMs;
  const reviewerSessionId = value.reviewerSessionId === undefined ? "" : value.reviewerSessionId;
  const verify = value.lastVerify;
  const agentError = value.lastAgentError === undefined ? null : value.lastAgentError;
  const requirementMode = value.requirementMode === undefined ? "quick" : value.requirementMode;
  const requirements = value.requirements === undefined ? null : parseLoopRequirementSpec(value.requirements);
  const acceptanceReview =
    value.acceptanceReview === undefined || value.acceptanceReview === null || requirements === null
      ? null
      : parseLoopAcceptanceReview(value.acceptanceReview, requirements);
  const requirementsApprovedAt = value.requirementsApprovedAt === undefined ? null : value.requirementsApprovedAt;
  const verificationPlan =
    value.verificationPlan === undefined ? undefined : parseVerificationPlan(value.verificationPlan);
  const stablePasses = value.stablePasses === undefined ? 1 : value.stablePasses;
  const flakyRetries = value.flakyRetries === undefined ? 0 : value.flakyRetries;
  const maxNoProgressRecoveries = value.maxNoProgressRecoveries === undefined ? 1 : value.maxNoProgressRecoveries;
  const passStreak = value.passStreak === undefined ? 0 : value.passStreak;
  const recoveryAttempts = value.recoveryAttempts === undefined ? 0 : value.recoveryAttempts;
  const controlSeq = value.controlSeq === undefined ? 0 : value.controlSeq;
  const controlRunId = value.controlRunId === undefined ? "" : value.controlRunId;
  const delivery = value.delivery === undefined ? undefined : parseDelivery(value.delivery);
  const priority = value.priority === undefined ? 0 : value.priority;
  const recovery = value.recovery;
  const stageResults = value.stageResults === undefined ? [] : parseStageResults(value.stageResults);
  const snapshots = value.snapshots === undefined ? [] : parseSnapshots(value.snapshots);
  const rollbackOnRegression = value.rollbackOnRegression === undefined ? false : value.rollbackOnRegression;
  const adaptiveBudget = value.adaptiveBudget === undefined ? false : value.adaptiveBudget;
  if (
    (value.schemaVersion !== undefined && value.schemaVersion !== 2) ||
    typeof value.loopId !== "string" ||
    !isValidLoopId(value.loopId) ||
    typeof value.task !== "string" ||
    typeof value.workspace !== "string" ||
    !isAbsolute(value.workspace) ||
    typeof value.verifyCommand !== "string" ||
    (value.verificationPlan !== undefined && verificationPlan === null) ||
    !isSafeInteger(stablePasses) ||
    stablePasses <= 0 ||
    stablePasses > 5 ||
    !isSafeInteger(flakyRetries) ||
    flakyRetries < 0 ||
    flakyRetries > 5 ||
    !isSafeInteger(maxNoProgressRecoveries) ||
    maxNoProgressRecoveries < 0 ||
    maxNoProgressRecoveries > 5 ||
    !isSafeInteger(passStreak) ||
    passStreak < 0 ||
    passStreak > stablePasses ||
    !isSafeInteger(recoveryAttempts) ||
    recoveryAttempts < 0 ||
    recoveryAttempts > maxNoProgressRecoveries ||
    !isSafeInteger(controlSeq) ||
    controlSeq < 0 ||
    typeof controlRunId !== "string" ||
    (controlRunId !== "" && !isValidLoopId(controlRunId)) ||
    (value.delivery !== undefined && delivery === null) ||
    (delivery !== undefined && value.status !== "passed") ||
    !isSafeInteger(priority) ||
    priority < -10 ||
    priority > 10 ||
    (recovery !== undefined &&
      (!isRecord(recovery) ||
        !isSafeInteger(recovery.attempts) ||
        recovery.attempts <= 0 ||
        !isIsoDate(recovery.lastAttemptAt) ||
        (recovery.nextAttemptAt !== undefined && !isIsoDate(recovery.nextAttemptAt)) ||
        (recovery.lastError !== undefined &&
          (typeof recovery.lastError !== "string" ||
            recovery.lastError.length === 0 ||
            recovery.lastError.length > 8_192)))) ||
    stageResults === null ||
    snapshots === null ||
    typeof rollbackOnRegression !== "boolean" ||
    typeof adaptiveBudget !== "boolean" ||
    !Number.isInteger(value.maxIterations) ||
    !isFiniteNumber(value.maxIterations) ||
    value.maxIterations <= 0 ||
    value.maxIterations > MAX_LOOP_ITERATIONS ||
    (budget !== null && (!isFiniteNumber(budget) || budget <= 0)) ||
    (tokenBudget !== null && (!isSafeInteger(tokenBudget) || tokenBudget <= 0)) ||
    (maxDurationMs !== null && (!isSafeInteger(maxDurationMs) || maxDurationMs <= 0)) ||
    (maxVerifyRuns !== null && (!isSafeInteger(maxVerifyRuns) || maxVerifyRuns <= 0)) ||
    !isSafeInteger(verifyTimeoutMs) ||
    verifyTimeoutMs <= 0 ||
    !isSafeInteger(agentTimeoutMs) ||
    agentTimeoutMs <= 0 ||
    !isSafeInteger(maxAgentRetries) ||
    maxAgentRetries < 0 ||
    !Number.isInteger(value.iterations) ||
    !isFiniteNumber(value.iterations) ||
    value.iterations < 0 ||
    value.iterations > value.maxIterations ||
    !isFiniteNumber(value.costUsd) ||
    value.costUsd < 0 ||
    !isSafeInteger(tokensUsed) ||
    tokensUsed < 0 ||
    !isSafeInteger(verifyRuns) ||
    verifyRuns < 0 ||
    (maxVerifyRuns !== null && verifyRuns > maxVerifyRuns) ||
    !isSafeInteger(elapsedMs) ||
    elapsedMs < 0 ||
    typeof value.sessionId !== "string" ||
    typeof reviewerSessionId !== "string" ||
    (verify !== null &&
      (!isRecord(verify) ||
        !Number.isInteger(verify.code) ||
        !isFiniteNumber(verify.code) ||
        typeof verify.output !== "string")) ||
    (agentError !== null &&
      (!isRecord(agentError) ||
        typeof agentError.code !== "string" ||
        typeof agentError.message !== "string" ||
        (agentError.hint !== undefined && typeof agentError.hint !== "string") ||
        (agentError.recoverable !== undefined && typeof agentError.recoverable !== "boolean") ||
        (agentError.sessionId !== undefined && typeof agentError.sessionId !== "string"))) ||
    !isLoopRequirementMode(requirementMode) ||
    (value.requirements !== undefined && value.requirements !== null && requirements === null) ||
    (value.acceptanceReview !== undefined && value.acceptanceReview !== null && acceptanceReview === null) ||
    (requirementsApprovedAt !== null && !isIsoDate(requirementsApprovedAt)) ||
    (requirementMode === "quick" && (requirements !== null || acceptanceReview !== null)) ||
    (requirementsApprovedAt !== null && (requirementMode !== "confirm" || requirements === null)) ||
    (requirementMode === "confirm" && acceptanceReview !== null && requirementsApprovedAt === null) ||
    (value.status === "requirements_pending" &&
      (requirementMode !== "confirm" ||
        requirements === null ||
        requirementsApprovedAt !== null ||
        acceptanceReview !== null)) ||
    (requirementMode !== "quick" && acceptanceReview !== null && requirements === null) ||
    typeof value.status !== "string" ||
    !LOOP_STATUSES.has(value.status as PersistedLoopStatus) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  )
    return null;

  const workspace = requireWorkspace(value.workspace);
  if (expectedWorkspace !== undefined && workspace !== requireWorkspace(expectedWorkspace)) return null;
  return {
    schemaVersion: 2,
    loopId: value.loopId,
    task: value.task,
    workspace,
    verifyCommand: value.verifyCommand,
    ...(verificationPlan ? { verificationPlan } : {}),
    stablePasses: stablePasses as number,
    flakyRetries: flakyRetries as number,
    maxNoProgressRecoveries: maxNoProgressRecoveries as number,
    adaptiveBudget,
    passStreak: passStreak as number,
    recoveryAttempts: recoveryAttempts as number,
    controlSeq: controlSeq as number,
    controlRunId,
    ...(delivery ? { delivery } : {}),
    priority: priority as number,
    ...(isRecord(recovery)
      ? {
          recovery: {
            attempts: recovery.attempts as number,
            lastAttemptAt: recovery.lastAttemptAt as string,
            ...(typeof recovery.nextAttemptAt === "string" ? { nextAttemptAt: recovery.nextAttemptAt } : {}),
            ...(typeof recovery.lastError === "string" ? { lastError: recovery.lastError } : {}),
          },
        }
      : {}),
    stageResults: stageResults as LoopStageResult[],
    snapshots: snapshots as LoopIterationSnapshot[],
    rollbackOnRegression,
    maxIterations: value.maxIterations,
    costBudgetUsd: budget,
    tokenBudget: tokenBudget as number | null,
    maxDurationMs: maxDurationMs as number | null,
    maxVerifyRuns: maxVerifyRuns as number | null,
    verifyTimeoutMs: verifyTimeoutMs as number,
    agentTimeoutMs: agentTimeoutMs as number,
    maxAgentRetries: maxAgentRetries as number,
    iterations: value.iterations,
    costUsd: value.costUsd,
    tokensUsed: tokensUsed as number,
    verifyRuns: verifyRuns as number,
    elapsedMs: elapsedMs as number,
    sessionId: value.sessionId,
    reviewerSessionId,
    lastVerify: verify === null ? null : { code: verify.code as number, output: verify.output as string },
    lastAgentError:
      agentError === null
        ? null
        : {
            code: agentError.code as string,
            message: agentError.message as string,
            ...(typeof agentError.hint === "string" ? { hint: agentError.hint } : {}),
            ...(typeof agentError.recoverable === "boolean" ? { recoverable: agentError.recoverable } : {}),
            ...(typeof agentError.sessionId === "string" ? { sessionId: agentError.sessionId } : {}),
          },
    requirementMode,
    requirements,
    acceptanceReview,
    requirementsApprovedAt,
    status: value.status as PersistedLoopStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function createLoopState(input: CreateLoopStateInput): LoopState {
  if (input.loopId !== undefined && !isValidLoopId(input.loopId)) {
    throw new Error(`Invalid loop id: ${input.loopId}`);
  }
  if (input.controlRunId !== undefined && input.controlRunId !== "" && !isValidLoopId(input.controlRunId)) {
    throw new Error(`Invalid loop control run id: ${input.controlRunId}`);
  }
  if (
    input.priority !== undefined &&
    (!Number.isSafeInteger(input.priority) || input.priority < -10 || input.priority > 10)
  ) {
    throw new RangeError("Loop priority must be an integer from -10 to 10");
  }
  const now = new Date().toISOString();
  const id = input.loopId ?? `loop-${randomUUID()}`;
  if (existsSync(loopFile(input.workspace, id))) {
    throw new Error(`Loop state already exists: ${id}`);
  }
  const state: LoopState = {
    schemaVersion: 2,
    loopId: id,
    task: input.task,
    workspace: requireWorkspace(input.workspace),
    verifyCommand: input.verifyCommand,
    ...(input.verificationPlan ? { verificationPlan: input.verificationPlan } : {}),
    stablePasses: input.stablePasses ?? 1,
    flakyRetries: input.flakyRetries ?? 0,
    maxNoProgressRecoveries: input.maxNoProgressRecoveries ?? 1,
    passStreak: 0,
    recoveryAttempts: 0,
    controlSeq: 0,
    controlRunId: input.controlRunId ?? "",
    priority: input.priority ?? 0,
    stageResults: [],
    snapshots: [],
    rollbackOnRegression: input.rollbackOnRegression ?? false,
    adaptiveBudget: input.adaptiveBudget ?? false,
    maxIterations: input.maxIterations,
    costBudgetUsd: input.costBudgetUsd ?? null,
    tokenBudget: input.tokenBudget ?? null,
    maxDurationMs: input.maxDurationMs ?? null,
    maxVerifyRuns: input.maxVerifyRuns ?? null,
    verifyTimeoutMs: input.verifyTimeoutMs ?? DEFAULT_LOOP_VERIFY_TIMEOUT_MS,
    agentTimeoutMs: input.agentTimeoutMs ?? DEFAULT_LOOP_AGENT_TIMEOUT_MS,
    maxAgentRetries: input.maxAgentRetries ?? DEFAULT_LOOP_AGENT_RETRIES,
    iterations: 0,
    costUsd: 0,
    tokensUsed: 0,
    verifyRuns: 0,
    elapsedMs: 0,
    sessionId: input.sessionId ?? "",
    reviewerSessionId: "",
    lastVerify: input.lastVerify ?? null,
    lastAgentError: null,
    requirementMode: input.requirementMode ?? "quick",
    requirements: null,
    acceptanceReview: null,
    requirementsApprovedAt: null,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  saveLoopState(state.workspace, state);
  return state;
}

export function saveLoopState(workspace: string, state: LoopState): void {
  const normalized = parseLoopState(state, workspace);
  if (!normalized) throw new Error("Invalid loop state");
  const compacted = compactLoopSnapshots(normalized);
  const serialized = `${JSON.stringify(compacted, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_LOOP_STATE_BYTES) {
    throw new FileTooLargeError(loopFile(workspace, compacted.loopId), MAX_LOOP_STATE_BYTES);
  }
  writeWorkspaceStateFileAtomic(
    requireWorkspace(workspace),
    join(".seekforge", "loops", `${compacted.loopId}.json`),
    serialized,
  );
}

export function loadLoopState(workspace: string, loopId: string): LoopState | null {
  if (!isValidLoopId(loopId)) throw new Error(`Invalid loop id: ${loopId}`);
  try {
    const raw = readWorkspaceStateFile(
      requireWorkspace(workspace),
      join(".seekforge", "loops", `${loopId}.json`),
      MAX_LOOP_STATE_BYTES,
    );
    return raw === undefined ? null : parseLoopState(JSON.parse(raw) as unknown, workspace);
  } catch {
    return null;
  }
}

export function listLoopStates(workspace: string): LoopState[] {
  let names: string[];
  try {
    names = readdirSync(loopsRoot(workspace));
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && isValidLoopId(name.slice(0, -5)))
    .map((name) => loadLoopState(workspace, name.slice(0, -5)))
    .filter((state): state is LoopState => state !== null)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Returns prioritized, retry-eligible interruptions, marking orphaned records first. */
export function recoverInterruptedLoops(workspace: string, options: { now?: Date; limit?: number } = {}): LoopState[] {
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Loop recovery time must be valid");
  const limit = options.limit ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Loop recovery limit must be positive");
  const recovered: LoopState[] = [];
  for (const state of listLoopStates(workspace)) {
    const owned = isLoopLifecycleActive(workspace, state.loopId) || isLoopLeaseActive(workspace, state.loopId);
    const retryEligible =
      state.recovery?.nextAttemptAt === undefined || Date.parse(state.recovery.nextAttemptAt) <= nowMs;
    if (state.status === "interrupted" && !owned && retryEligible) {
      recovered.push(state);
      continue;
    }
    if (state.status === "interrupted") continue;
    if ((state.status !== "running" && state.status !== "paused") || owned) continue;
    const next = { ...state, status: "interrupted" as const, updatedAt: new Date().toISOString() };
    saveLoopState(workspace, next);
    if (retryEligible) recovered.push(next);
  }
  return recovered
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
    .slice(0, limit);
}

/** Persists bounded exponential backoff after an automatic resume failure. */
export function recordLoopRecoveryFailure(
  workspace: string,
  loopId: string,
  error: unknown,
  now = new Date(),
): LoopState {
  const state = loadLoopState(workspace, loopId);
  if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Loop recovery time must be valid");
  const attempts = (state.recovery?.attempts ?? 0) + 1;
  const delayMs = Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));
  const message = (error instanceof Error ? error.message : String(error)).trim().slice(0, 8_192) || "recovery failed";
  const next: LoopState = {
    ...state,
    status: "interrupted",
    recovery: {
      attempts,
      lastAttemptAt: now.toISOString(),
      nextAttemptAt: new Date(nowMs + delayMs).toISOString(),
      lastError: message,
    },
    updatedAt: now.toISOString(),
  };
  saveLoopState(workspace, next);
  return next;
}

export function setLoopPriority(workspace: string, loopId: string, priority: number): LoopState {
  if (!Number.isSafeInteger(priority) || priority < -10 || priority > 10) {
    throw new RangeError("Loop priority must be an integer from -10 to 10");
  }
  const lifecycleLease = acquireLoopLifecycleLease(workspace, loopId);
  try {
    const state = loadLoopState(workspace, loopId);
    if (!state) throw new Error(`Persisted loop not found or invalid: ${loopId}`);
    const next = { ...state, priority, updatedAt: new Date().toISOString() };
    saveLoopState(workspace, next);
    return next;
  } finally {
    lifecycleLease.release();
  }
}

export function removeLoopState(workspace: string, loopId: string, workspaceGuard?: SessionLease): boolean {
  let deliveryLease: LoopLease;
  try {
    deliveryLease = acquireLoopLifecycleLease(workspace, loopId, workspaceGuard);
  } catch (error) {
    if (isLoopDeliveryActive(workspace, loopId)) throw new Error(`Cannot remove active delivery: ${loopId}`);
    throw error;
  }
  try {
    let loopLease: LoopLease;
    try {
      loopLease = acquireLoopLease(workspace, loopId, true);
    } catch (error) {
      if (isLoopLeaseActive(workspace, loopId)) throw new Error(`Cannot remove running loop: ${loopId}`);
      throw error;
    }
    try {
      try {
        rmSync(loopFile(workspace, loopId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
      rmSync(loopLogFile(workspace, loopId), { force: true });
      rmSync(resolveForWrite(requireWorkspace(workspace), join(".seekforge", "loops", `${loopId}.control.json`)), {
        force: true,
      });
      for (let segment = 1; segment < MAX_LOOP_LOG_SEGMENTS; segment++) {
        rmSync(`${loopLogFile(workspace, loopId)}.${segment}`, { force: true });
      }
      return true;
    } finally {
      loopLease.release();
    }
  } finally {
    deliveryLease.release();
  }
}

function isLoopPruneEligible(state: LoopState): boolean {
  if (
    state.status === "running" ||
    state.status === "paused" ||
    state.status === "interrupted" ||
    state.status === "requirements_pending"
  )
    return false;
  if (state.delivery && state.delivery.phase !== "finalized") return false;
  return true;
}

/** Prunes only terminal, non-resumable Loop records after rechecking lifecycle ownership. */
export function pruneLoopStates(workspace: string, options: LoopPruneOptions): LoopPruneResult {
  if (options.maxAgeDays === undefined && options.maxTerminalCount === undefined) {
    throw new Error("Loop pruning requires maxAgeDays or maxTerminalCount");
  }
  if (options.maxAgeDays !== undefined && (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays < 0))
    throw new RangeError("Loop maxAgeDays must be a non-negative finite number");
  if (
    options.maxTerminalCount !== undefined &&
    (!Number.isSafeInteger(options.maxTerminalCount) || options.maxTerminalCount < 0)
  )
    throw new RangeError("Loop maxTerminalCount must be a non-negative safe integer");
  const nowMs = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("Loop prune time must be valid");
  const ownedGuard = options.dryRun || options.workspaceGuard ? undefined : acquireWorkspaceSessionGuard(workspace);
  const workspaceGuard = options.workspaceGuard ?? ownedGuard;
  try {
    const terminal = listLoopStates(workspace).filter(isLoopPruneEligible);
    const candidates = terminal.filter((state, index) => {
      const tooOld =
        options.maxAgeDays !== undefined &&
        Date.parse(state.updatedAt) <= nowMs - options.maxAgeDays * 24 * 60 * 60_000;
      const overCount = options.maxTerminalCount !== undefined && index >= options.maxTerminalCount;
      return tooOld || overCount;
    });
    const result: LoopPruneResult = { candidates: candidates.map((state) => state.loopId), removed: [], skipped: [] };
    if (options.dryRun) return result;
    for (const candidate of candidates) {
      const current = loadLoopState(workspace, candidate.loopId);
      if (
        current === null ||
        !isLoopPruneEligible(current) ||
        isLoopLifecycleActive(workspace, candidate.loopId) ||
        isLoopLeaseActive(workspace, candidate.loopId)
      ) {
        result.skipped.push(candidate.loopId);
        continue;
      }
      try {
        if (removeLoopState(workspace, candidate.loopId, workspaceGuard)) result.removed.push(candidate.loopId);
        else result.skipped.push(candidate.loopId);
      } catch {
        result.skipped.push(candidate.loopId);
      }
    }
    return result;
  } finally {
    ownedGuard?.release();
  }
}
