import { createHash } from "node:crypto";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import type { EngineeringGraphDistributionReport } from "./graph-simulation.js";
import type { EngineeringGraphState } from "./graph-state.js";
import { isDenseArray, nextOrchestrationVersion } from "./orchestration.js";
import type { OrchestrationDeployment } from "./orchestration-deployments.js";
import { acquireSessionLease } from "./session-lease.js";

export type OrchestrationControlObservation = {
  id: string;
  proposalId: string;
  proposalUpdatedAt: string;
  attempt: number;
  scope: "loop" | "graph";
  sourceId: string;
  recordedAt: string;
  baseline: OrchestrationDeployment["baseline"];
  observed: NonNullable<OrchestrationDeployment["observed"]>;
  verdict: "improved" | "stable" | "regressed";
};

export type OrchestrationForecastObservation = {
  id: string;
  graphId: string;
  fingerprint: string;
  controlRunId: string;
  recordedAt: string;
  predictedP50Ms: number;
  predictedP95Ms: number;
  predictedBreachProbability: number;
  actualDurationMs: number;
  breached: boolean;
};

export type OrchestrationBurnRateWindow = {
  hours: 1 | 6 | 24;
  samples: number;
  breaches: number;
  breachRate: number;
  burnRate: number;
  status: "unknown" | "healthy" | "warning" | "critical";
};

export type OrchestrationCalibrationReport = {
  samples: number;
  meanAbsoluteErrorMs: number;
  p95Coverage: number;
  brierScore: number;
  confidence: "none" | "low" | "medium" | "high";
};

export type WorkspaceOrchestrationControlAnalytics = {
  generatedAt: string;
  observations: number;
  burnRates: OrchestrationBurnRateWindow[];
  calibration: OrchestrationCalibrationReport;
};

type Document = {
  version: 1;
  updatedAt: string;
  observations: OrchestrationControlObservation[];
  forecasts: OrchestrationForecastObservation[];
};

const PATH = ".seekforge/orchestration-control.json";
const MAX_BYTES = 512 * 1024;
const MAX_OBSERVATIONS = 512;
const MAX_FORECASTS = 512;
const HASH_RE = /^[a-f0-9]{64}$/;
const PROPOSAL_RE = /^opt-[a-f0-9]{20}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validMetric(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["costPerUnit", "durationPerUnitMs", "failures", "terminal"]) &&
    finiteNonNegative(value.costPerUnit) &&
    Number.isSafeInteger(value.durationPerUnitMs) &&
    (value.durationPerUnitMs as number) >= 0 &&
    Number.isSafeInteger(value.failures) &&
    (value.failures as number) >= 0 &&
    typeof value.terminal === "boolean"
  );
}

function validObservation(value: unknown): value is OrchestrationControlObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "proposalId",
      "proposalUpdatedAt",
      "attempt",
      "scope",
      "sourceId",
      "recordedAt",
      "baseline",
      "observed",
      "verdict",
    ]) &&
    typeof value.id === "string" &&
    HASH_RE.test(value.id) &&
    typeof value.proposalId === "string" &&
    PROPOSAL_RE.test(value.proposalId) &&
    typeof value.proposalUpdatedAt === "string" &&
    Number.isFinite(Date.parse(value.proposalUpdatedAt)) &&
    Number.isSafeInteger(value.attempt) &&
    (value.attempt as number) >= 1 &&
    (value.scope === "loop" || value.scope === "graph") &&
    typeof value.sourceId === "string" &&
    ID_RE.test(value.sourceId) &&
    typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt)) &&
    validMetric(value.baseline) &&
    validMetric(value.observed) &&
    (value.observed as { terminal: boolean }).terminal &&
    (value.verdict === "improved" || value.verdict === "stable" || value.verdict === "regressed")
  );
}

function validForecast(value: unknown): value is OrchestrationForecastObservation {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "graphId",
      "fingerprint",
      "controlRunId",
      "recordedAt",
      "predictedP50Ms",
      "predictedP95Ms",
      "predictedBreachProbability",
      "actualDurationMs",
      "breached",
    ]) &&
    typeof value.id === "string" &&
    HASH_RE.test(value.id) &&
    typeof value.graphId === "string" &&
    ID_RE.test(value.graphId) &&
    typeof value.fingerprint === "string" &&
    HASH_RE.test(value.fingerprint) &&
    typeof value.controlRunId === "string" &&
    ID_RE.test(value.controlRunId) &&
    typeof value.recordedAt === "string" &&
    Number.isFinite(Date.parse(value.recordedAt)) &&
    Number.isSafeInteger(value.predictedP50Ms) &&
    (value.predictedP50Ms as number) >= 0 &&
    Number.isSafeInteger(value.predictedP95Ms) &&
    (value.predictedP95Ms as number) >= (value.predictedP50Ms as number) &&
    typeof value.predictedBreachProbability === "number" &&
    Number.isFinite(value.predictedBreachProbability) &&
    value.predictedBreachProbability >= 0 &&
    value.predictedBreachProbability <= 1 &&
    Number.isSafeInteger(value.actualDurationMs) &&
    (value.actualDurationMs as number) >= 0 &&
    typeof value.breached === "boolean"
  );
}

function emptyDocument(): Document {
  return { version: 1, updatedAt: new Date(0).toISOString(), observations: [], forecasts: [] };
}

function parseDocument(raw: string): Document {
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "updatedAt", "observations", "forecasts"]) ||
    value.version !== 1 ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    !isDenseArray(value.observations) ||
    value.observations.length > MAX_OBSERVATIONS ||
    !value.observations.every(validObservation) ||
    new Set(value.observations.map((item) => item.id)).size !== value.observations.length ||
    !isDenseArray(value.forecasts) ||
    value.forecasts.length > MAX_FORECASTS ||
    !value.forecasts.every(validForecast) ||
    new Set(value.forecasts.map((item) => item.id)).size !== value.forecasts.length
  ) {
    throw new Error("Persisted orchestration control observations are invalid");
  }
  return value as Document;
}

function readDocument(workspace: string): Document {
  const raw = readWorkspaceStateFile(workspace, PATH, MAX_BYTES);
  return raw === undefined ? emptyDocument() : parseDocument(raw);
}

function writeDocument(workspace: string, document: Document): void {
  const serialized = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("Orchestration control observations exceed limit");
  writeWorkspaceStateFileAtomic(workspace, PATH, serialized);
}

function observationId(deployment: OrchestrationDeployment): string {
  return createHash("sha256")
    .update(
      `${deployment.proposalId}\0${deployment.proposalUpdatedAt}\0${deployment.attempt}\0${deployment.verdict}\0${JSON.stringify(deployment.observed)}`,
    )
    .digest("hex");
}

/** Records one terminal deployment observation exactly once. */
export function recordOrchestrationDeploymentObservation(
  workspace: string,
  deployment: OrchestrationDeployment,
): OrchestrationControlObservation | undefined {
  if (!deployment.observed?.terminal || deployment.verdict === "pending") return undefined;
  const observation: OrchestrationControlObservation = {
    id: observationId(deployment),
    proposalId: deployment.proposalId,
    proposalUpdatedAt: deployment.proposalUpdatedAt,
    attempt: deployment.attempt,
    scope: deployment.scope,
    sourceId: deployment.sourceId,
    recordedAt: deployment.updatedAt,
    baseline: deployment.baseline,
    observed: deployment.observed,
    verdict: deployment.verdict,
  };
  if (!validObservation(observation)) throw new Error("Orchestration deployment observation is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-control");
  try {
    const current = readDocument(workspace);
    if (current.observations.some((item) => item.id === observation.id)) return observation;
    const observations = [...current.observations, observation]
      .sort(
        (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.id.localeCompare(right.id),
      )
      .slice(-MAX_OBSERVATIONS);
    writeDocument(workspace, {
      ...current,
      updatedAt: nextOrchestrationVersion(current.updatedAt),
      observations,
    });
    return observation;
  } finally {
    lease.release();
  }
}

/** Persists calibration evidence only for a terminal exact Graph generation. */
export function recordEngineeringGraphForecastObservation(
  workspace: string,
  state: EngineeringGraphState,
  forecast: EngineeringGraphDistributionReport,
): OrchestrationForecastObservation | undefined {
  if (
    !["passed", "failed", "cancelled"].includes(state.status) ||
    forecast.graphId !== state.graphId ||
    !ID_RE.test(state.controlRunId)
  ) {
    return undefined;
  }
  const predictedBreachProbability = Math.max(
    forecast.durationBreachProbability,
    forecast.deadlineBreachProbability,
    forecast.budgetBreachProbability,
  );
  const breached =
    (state.definition.maxDurationMs !== undefined && state.elapsedMs > state.definition.maxDurationMs) ||
    state.status !== "passed";
  const id = createHash("sha256").update(`${state.graphId}\0${state.fingerprint}\0${state.controlRunId}`).digest("hex");
  const observation: OrchestrationForecastObservation = {
    id,
    graphId: state.graphId,
    fingerprint: state.fingerprint,
    controlRunId: state.controlRunId,
    recordedAt: state.completedAt ?? state.updatedAt,
    predictedP50Ms: forecast.makespanMs.p50,
    predictedP95Ms: forecast.makespanMs.p95,
    predictedBreachProbability,
    actualDurationMs: state.elapsedMs,
    breached,
  };
  if (!validForecast(observation)) throw new Error("Graph forecast observation is invalid");
  const lease = acquireSessionLease(workspace, "orchestration-control");
  try {
    const current = readDocument(workspace);
    if (current.forecasts.some((item) => item.id === observation.id)) return observation;
    const forecasts = [...current.forecasts, observation]
      .sort(
        (left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt) || left.id.localeCompare(right.id),
      )
      .slice(-MAX_FORECASTS);
    writeDocument(workspace, {
      ...current,
      updatedAt: nextOrchestrationVersion(current.updatedAt),
      forecasts,
    });
    return observation;
  } finally {
    lease.release();
  }
}

function confidence(samples: number): OrchestrationCalibrationReport["confidence"] {
  return samples >= 30 ? "high" : samples >= 10 ? "medium" : samples >= 3 ? "low" : "none";
}

/** Reads bounded durable observations and derives multi-window burn rate plus forecast calibration. */
export function buildWorkspaceOrchestrationControlAnalytics(
  workspace: string,
  options: { maxBreachRate?: number; now?: Date } = {},
): WorkspaceOrchestrationControlAnalytics {
  const maxBreachRate = options.maxBreachRate ?? 0.05;
  if (!Number.isFinite(maxBreachRate) || maxBreachRate < 0 || maxBreachRate > 1) {
    throw new RangeError("Orchestration maxBreachRate must be from 0 to 1");
  }
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Orchestration analytics time is invalid");
  const document = readDocument(workspace);
  const burnRates = ([1, 6, 24] as const).map((hours): OrchestrationBurnRateWindow => {
    const observations = document.observations.filter((observation) => {
      const recordedAt = Date.parse(observation.recordedAt);
      return recordedAt <= nowMs && recordedAt >= nowMs - hours * 60 * 60_000;
    });
    const breaches = observations.filter((observation) => observation.verdict === "regressed").length;
    const breachRate = observations.length === 0 ? 0 : breaches / observations.length;
    const burnRate = Math.min(1_000, maxBreachRate === 0 ? (breaches > 0 ? 1_000 : 0) : breachRate / maxBreachRate);
    return {
      hours,
      samples: observations.length,
      breaches,
      breachRate,
      burnRate,
      status: observations.length === 0 ? "unknown" : burnRate > 2 ? "critical" : burnRate > 1 ? "warning" : "healthy",
    };
  });
  const forecasts = document.forecasts.filter((observation) => Date.parse(observation.recordedAt) <= nowMs);
  const samples = forecasts.length;
  const meanAbsoluteErrorMs =
    samples === 0
      ? 0
      : Math.round(
          forecasts.reduce(
            (sum, observation) => sum + Math.abs(observation.actualDurationMs - observation.predictedP50Ms),
            0,
          ) / samples,
        );
  const p95Coverage =
    samples === 0
      ? 0
      : forecasts.filter((observation) => observation.actualDurationMs <= observation.predictedP95Ms).length / samples;
  const brierScore =
    samples === 0
      ? 0
      : forecasts.reduce(
          (sum, observation) => sum + (observation.predictedBreachProbability - (observation.breached ? 1 : 0)) ** 2,
          0,
        ) / samples;
  return {
    generatedAt: now.toISOString(),
    observations: document.observations.length,
    burnRates,
    calibration: { samples, meanAbsoluteErrorMs, p95Coverage, brierScore, confidence: confidence(samples) },
  };
}

export function listOrchestrationControlObservations(workspace: string): {
  observations: OrchestrationControlObservation[];
  forecasts: OrchestrationForecastObservation[];
} {
  const document = readDocument(workspace);
  return { observations: document.observations, forecasts: document.forecasts };
}
