import type { EngineeringGraphRunSnapshot } from "./graph-run-history.js";
import type { EngineeringGraphState } from "./graph-state.js";

type ComparableEngineeringGraphRun = Pick<
  EngineeringGraphState | EngineeringGraphRunSnapshot,
  "graphId" | "status" | "spentCost" | "spentTokens" | "elapsedMs" | "createdAt" | "completedAt" | "results"
>;

export type EngineeringGraphRunComparison = {
  graphId: string;
  statusChanged: boolean;
  costDeltaUsd: number;
  tokenDelta: number;
  durationDeltaMs?: number;
  nodes: Array<{
    id: string;
    before?: string;
    after?: string;
    costDeltaUsd: number;
    tokenDelta: number;
  }>;
};

/** Pure run-to-run comparison used by CLI/Desktop observability surfaces. */
export function compareEngineeringGraphRuns(
  before: ComparableEngineeringGraphRun,
  after: ComparableEngineeringGraphRun,
): EngineeringGraphRunComparison {
  if (before.graphId !== after.graphId) throw new Error("Graph comparison requires matching graph ids");
  const beforeNodes = new Map(before.results.map((result) => [result.id, result]));
  const afterNodes = new Map(after.results.map((result) => [result.id, result]));
  const ids = [...new Set([...beforeNodes.keys(), ...afterNodes.keys()])].sort();
  return {
    graphId: after.graphId,
    statusChanged: before.status !== after.status,
    costDeltaUsd: after.spentCost - before.spentCost,
    tokenDelta: after.spentTokens - before.spentTokens,
    durationDeltaMs: after.elapsedMs - before.elapsedMs,
    nodes: ids.map((id) => {
      const previous = beforeNodes.get(id);
      const current = afterNodes.get(id);
      return {
        id,
        ...(previous ? { before: previous.status } : {}),
        ...(current ? { after: current.status } : {}),
        costDeltaUsd: (current?.costUsd ?? 0) - (previous?.costUsd ?? 0),
        tokenDelta: (current?.tokensUsed ?? 0) - (previous?.tokensUsed ?? 0),
      };
    }),
  };
}
