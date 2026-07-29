import { isRecord } from "../util/guards.js";
import { readWorkspaceStateFile, writeWorkspaceStateFileAtomic } from "../util/workspace-state.js";
import { isDenseArray } from "./orchestration.js";
import type { EngineeringGraphState, GraphNodeResult } from "./graph-state.js";
import { isValidLoopDagId } from "./loop-dag-validation.js";

export type EngineeringGraphRunSnapshot = {
  runNumber: number;
  graphId: string;
  fingerprint: string;
  status: EngineeringGraphState["status"];
  spentCost: number;
  spentTokens: number;
  createdAt: string;
  completedAt: string;
  results: Array<Pick<GraphNodeResult, "id" | "status" | "costUsd" | "tokensUsed">>;
};

const MAX_RUN_SNAPSHOTS = 16;
const MAX_BYTES = 512 * 1024;

function path(graphId: string): string {
  if (!isValidLoopDagId(graphId)) throw new Error(`Invalid Graph id: ${graphId}`);
  return `.seekforge/graphs/${graphId}.runs.json`;
}

export function readEngineeringGraphRunSnapshots(workspace: string, graphId: string): EngineeringGraphRunSnapshot[] {
  try {
    const raw = readWorkspaceStateFile(workspace, path(graphId), MAX_BYTES);
    if (raw === undefined) return [];
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isDenseArray(value.runs) || value.runs.length > MAX_RUN_SNAPSHOTS) {
      return [];
    }
    const runs = value.runs.flatMap((run): EngineeringGraphRunSnapshot[] => {
      if (
        !isRecord(run) ||
        !Number.isSafeInteger(run.runNumber) ||
        (run.runNumber as number) < 1 ||
        run.graphId !== graphId ||
        typeof run.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(run.fingerprint) ||
        !["passed", "failed", "cancelled"].includes(String(run.status)) ||
        typeof run.spentCost !== "number" ||
        !Number.isFinite(run.spentCost) ||
        run.spentCost < 0 ||
        !Number.isSafeInteger(run.spentTokens) ||
        (run.spentTokens as number) < 0 ||
        typeof run.createdAt !== "string" ||
        !Number.isFinite(Date.parse(run.createdAt)) ||
        typeof run.completedAt !== "string" ||
        !Number.isFinite(Date.parse(run.completedAt)) ||
        !isDenseArray(run.results) ||
        run.results.length > 128
      ) {
        return [];
      }
      const results = run.results.flatMap((result) => {
        if (
          !isRecord(result) ||
          !isValidLoopDagId(result.id) ||
          !["passed", "failed", "skipped", "waiting_approval", "waiting_signal"].includes(String(result.status)) ||
          typeof result.costUsd !== "number" ||
          !Number.isFinite(result.costUsd) ||
          result.costUsd < 0 ||
          !Number.isSafeInteger(result.tokensUsed) ||
          (result.tokensUsed as number) < 0
        ) {
          return [];
        }
        return [result as EngineeringGraphRunSnapshot["results"][number]];
      });
      if (
        results.length !== run.results.length ||
        new Set(results.map((result) => result.id)).size !== results.length
      ) {
        return [];
      }
      return [{ ...(run as EngineeringGraphRunSnapshot), results }];
    });
    if (
      runs.length !== value.runs.length ||
      runs.some((run, index) => index > 0 && run.runNumber <= runs[index - 1]!.runNumber)
    ) {
      return [];
    }
    return runs;
  } catch {
    return [];
  }
}

export function archiveEngineeringGraphRun(workspace: string, state: EngineeringGraphState): void {
  if (!state.completedAt || !["passed", "failed", "cancelled"].includes(state.status)) return;
  const existing = readEngineeringGraphRunSnapshots(workspace, state.graphId);
  if (existing.some((run) => run.completedAt === state.completedAt && run.fingerprint === state.fingerprint)) return;
  const snapshot: EngineeringGraphRunSnapshot = {
    runNumber: (existing.at(-1)?.runNumber ?? 0) + 1,
    graphId: state.graphId,
    fingerprint: state.fingerprint,
    status: state.status,
    spentCost: state.spentCost,
    spentTokens: state.spentTokens,
    createdAt: state.createdAt,
    completedAt: state.completedAt,
    results: state.results.map(({ id, status, costUsd, tokensUsed }) => ({ id, status, costUsd, tokensUsed })),
  };
  writeWorkspaceStateFileAtomic(
    workspace,
    path(state.graphId),
    `${JSON.stringify({ version: 1, runs: [...existing, snapshot].slice(-MAX_RUN_SNAPSHOTS) })}\n`,
  );
}
