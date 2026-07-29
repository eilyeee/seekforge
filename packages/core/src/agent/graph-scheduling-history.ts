import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray } from "./orchestration.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";

export type GraphSchedulingObservation = {
  graphId: string;
  nodeId: string;
  durationMs: number;
  passed: boolean;
  recordedAt: string;
};

const HISTORY_PATH = ".seekforge/graph-scheduling-history.json";
const MAX_BYTES = 128 * 1024;
const MAX_OBSERVATIONS = 512;

function readHistory(workspace: string): GraphSchedulingObservation[] {
  try {
    const raw = readWorkspaceStateFile(workspace, HISTORY_PATH, MAX_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isDenseArray(value.observations)) return [];
    return value.observations.slice(-MAX_OBSERVATIONS).flatMap((item): GraphSchedulingObservation[] => {
      if (
        !isRecord(item) ||
        !isValidLoopDagId(item.graphId) ||
        !isValidLoopDagId(item.nodeId) ||
        !Number.isSafeInteger(item.durationMs) ||
        (item.durationMs as number) < 0 ||
        typeof item.passed !== "boolean" ||
        typeof item.recordedAt !== "string" ||
        !Number.isFinite(Date.parse(item.recordedAt))
      ) {
        return [];
      }
      return [item as GraphSchedulingObservation];
    });
  } catch {
    return [];
  }
}

export function graphSchedulingScore(workspace: string, graphId: string, nodeId: string): number {
  const observations = readHistory(workspace)
    .filter((item) => item.graphId === graphId && item.nodeId === nodeId)
    .slice(-16);
  if (observations.length === 0) return 0;
  let weightedDuration = 0;
  let weightedFailures = 0;
  let weights = 0;
  for (const [index, observation] of observations.entries()) {
    const weight = index + 1;
    weights += weight;
    weightedDuration += Math.min(observation.durationMs, 24 * 60 * 60_000) * weight;
    if (!observation.passed) weightedFailures += weight;
  }
  // Failure-prone work starts first so a doomed graph fails before consuming
  // budget elsewhere; duration is the bounded tie-breaker.
  return (weightedFailures / weights) * 1_000_000_000 + weightedDuration / weights;
}

export function recordGraphSchedulingObservation(workspace: string, observation: GraphSchedulingObservation): void {
  if (
    !isValidLoopDagId(observation.graphId) ||
    !isValidLoopDagId(observation.nodeId) ||
    !Number.isSafeInteger(observation.durationMs) ||
    observation.durationMs < 0 ||
    typeof observation.passed !== "boolean" ||
    !Number.isFinite(Date.parse(observation.recordedAt))
  ) {
    throw new Error("Graph scheduling observation is invalid");
  }
  const observations = [...readHistory(workspace), observation].slice(-MAX_OBSERVATIONS);
  writeWorkspaceStateFileAtomic(workspace, HISTORY_PATH, `${JSON.stringify({ version: 1, observations })}\n`);
}
