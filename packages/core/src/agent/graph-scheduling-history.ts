import { serializeNewestJsonArray } from "../util/bounded-json.js";
import { hasOnlyKeys, isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray } from "./orchestration.js";
import { acquireSessionLease, type SessionLease } from "./session-lease.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";

export type GraphSchedulingObservation = {
  graphId: string;
  nodeId: string;
  fingerprint: string;
  durationMs: number;
  passed: boolean;
  recordedAt: string;
};

export type GraphSchedulingIntelligence = {
  graphId: string;
  nodeId: string;
  fingerprint: string;
  samples: number;
  passes: number;
  failures: number;
  consecutiveFailures: number;
  averageDurationMs: number;
  lastPassed: boolean;
  updatedAt: string;
};

export type GraphSchedulingIntelligenceFinding = {
  graphId: string;
  nodeId: string;
  fingerprint: string;
  kind: "failure_streak" | "failure_rate";
  severity: "warning" | "critical";
  message: string;
};

const HISTORY_PATH = ".seekforge/graph-scheduling-history.json";
const MAX_BYTES = 128 * 1024;
const MAX_OBSERVATIONS = 512;
const MAX_SCORE_OBSERVATIONS = 16;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;

function validObservation(value: unknown, now: number): value is GraphSchedulingObservation {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["graphId", "nodeId", "fingerprint", "durationMs", "passed", "recordedAt"])
  ) {
    return false;
  }
  const recordedAt = typeof value.recordedAt === "string" ? Date.parse(value.recordedAt) : Number.NaN;
  return (
    isValidLoopDagId(value.graphId) &&
    isValidLoopDagId(value.nodeId) &&
    typeof value.fingerprint === "string" &&
    FINGERPRINT_RE.test(value.fingerprint) &&
    typeof value.durationMs === "number" &&
    Number.isSafeInteger(value.durationMs) &&
    value.durationMs >= 0 &&
    typeof value.passed === "boolean" &&
    Number.isFinite(recordedAt) &&
    recordedAt <= now &&
    now - recordedAt <= MAX_AGE_MS
  );
}

function serializeObservations(observations: readonly GraphSchedulingObservation[]): string {
  return serializeNewestJsonArray(observations, {
    maxItems: MAX_OBSERVATIONS,
    maxBytes: MAX_BYTES,
    envelope: (retained) => ({ version: 2, observations: retained }),
    overflowMessage: "Graph scheduling observation exceeds the durable byte limit",
  }).serialized;
}

export function readGraphSchedulingObservations(workspace: string): GraphSchedulingObservation[] {
  try {
    const raw = readWorkspaceStateFile(workspace, HISTORY_PATH, MAX_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasOnlyKeys(value, ["version", "observations"]) ||
      value.version !== 2 ||
      !isDenseArray(value.observations) ||
      value.observations.length > MAX_OBSERVATIONS
    ) {
      return [];
    }
    const now = Date.now();
    return value.observations.filter((item): item is GraphSchedulingObservation => validObservation(item, now));
  } catch {
    return [];
  }
}

/** Higher scores run earlier within a static criticality tier. */
export function graphSchedulingScore(workspace: string, graphId: string, nodeId: string): number;
export function graphSchedulingScore(
  workspace: string,
  graphId: string,
  fingerprint: string,
  nodeId: string,
  history?: readonly GraphSchedulingObservation[],
): number;
export function graphSchedulingScore(
  workspace: string,
  graphId: string,
  fingerprintOrNodeId: string,
  nodeId?: string,
  history?: readonly GraphSchedulingObservation[],
): number {
  // Keep the former exported signature source-compatible, but fail closed
  // because id-only history cannot prove which Graph definition it measured.
  if (nodeId === undefined) return 0;
  const observations = chronologicalObservations(
    (history ?? readGraphSchedulingObservations(workspace)).filter(
      (item) => item.graphId === graphId && item.fingerprint === fingerprintOrNodeId && item.nodeId === nodeId,
    ),
  ).slice(-MAX_SCORE_OBSERVATIONS);
  if (observations.length === 0) return 0;
  let weightedDuration = 0;
  let weightedFailures = 0;
  let weights = 0;
  for (const [index, observation] of observations.entries()) {
    const weight = index + 1;
    weights += weight;
    weightedDuration += Math.min(observation.durationMs, MAX_DURATION_MS) * weight;
    if (!observation.passed) weightedFailures += weight;
  }
  // Failure-prone work starts first so a doomed graph fails before consuming
  // budget elsewhere; bounded duration remains only the tie-breaker.
  return Math.min(Number.MAX_SAFE_INTEGER, (weightedFailures / weights) * 1_000_000_000 + weightedDuration / weights);
}

function chronologicalObservations(observations: readonly GraphSchedulingObservation[]): GraphSchedulingObservation[] {
  return observations
    .map((observation, index) => ({ observation, index, recordedAt: Date.parse(observation.recordedAt) }))
    .sort((left, right) => {
      const difference = left.recordedAt - right.recordedAt;
      return Number.isFinite(difference) && difference !== 0 ? difference : left.index - right.index;
    })
    .map(({ observation }) => observation);
}

export function recordGraphSchedulingObservation(
  workspace: string,
  observation: GraphSchedulingObservation,
  workspaceGuard?: SessionLease,
): void {
  if (!validObservation(observation, Date.now())) throw new Error("Graph scheduling observation is invalid");
  const lease = acquireSessionLease(workspace, "graph-scheduling-history", workspaceGuard);
  try {
    // Reload under ownership so concurrent recorders cannot commit a stale snapshot.
    const observations = chronologicalObservations([...readGraphSchedulingObservations(workspace), observation]);
    writeWorkspaceStateFileAtomic(workspace, HISTORY_PATH, serializeObservations(observations));
  } finally {
    lease.release();
  }
}

export function summarizeGraphSchedulingIntelligence(
  observations: readonly GraphSchedulingObservation[],
): GraphSchedulingIntelligence[] {
  const entries = new Map<string, GraphSchedulingIntelligence>();
  for (const observation of chronologicalObservations(observations)) {
    const key = `${observation.graphId}\0${observation.nodeId}\0${observation.fingerprint}`;
    const previous = entries.get(key);
    if (!previous) {
      entries.set(key, {
        graphId: observation.graphId,
        nodeId: observation.nodeId,
        fingerprint: observation.fingerprint,
        samples: 1,
        passes: observation.passed ? 1 : 0,
        failures: observation.passed ? 0 : 1,
        consecutiveFailures: observation.passed ? 0 : 1,
        averageDurationMs: observation.durationMs,
        lastPassed: observation.passed,
        updatedAt: observation.recordedAt,
      });
      continue;
    }
    const samples = previous.samples + 1;
    previous.samples = samples;
    previous.passes += observation.passed ? 1 : 0;
    previous.failures += observation.passed ? 0 : 1;
    previous.consecutiveFailures = observation.passed ? 0 : previous.consecutiveFailures + 1;
    previous.averageDurationMs = Math.round(
      previous.averageDurationMs + (observation.durationMs - previous.averageDurationMs) / samples,
    );
    previous.lastPassed = observation.passed;
    previous.updatedAt = observation.recordedAt;
  }
  return [...entries.values()];
}

export function analyzeGraphSchedulingIntelligence(
  entries: readonly GraphSchedulingIntelligence[],
): GraphSchedulingIntelligenceFinding[] {
  const findings: GraphSchedulingIntelligenceFinding[] = [];
  for (const entry of entries) {
    if (entry.consecutiveFailures >= 2) {
      findings.push({
        graphId: entry.graphId,
        nodeId: entry.nodeId,
        fingerprint: entry.fingerprint,
        kind: "failure_streak",
        severity: entry.consecutiveFailures >= 4 ? "critical" : "warning",
        message: `${entry.graphId}/${entry.nodeId} has failed ${entry.consecutiveFailures} consecutive runs`,
      });
    }
    const failureRate = entry.failures / entry.samples;
    if (entry.samples >= 4 && failureRate >= 0.5) {
      findings.push({
        graphId: entry.graphId,
        nodeId: entry.nodeId,
        fingerprint: entry.fingerprint,
        kind: "failure_rate",
        severity: failureRate >= 0.75 ? "critical" : "warning",
        message: `${entry.graphId}/${entry.nodeId} fails ${Math.round(failureRate * 100)}% of recent runs`,
      });
    }
  }
  return findings;
}
