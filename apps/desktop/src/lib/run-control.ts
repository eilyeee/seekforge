import type { RunRecordSummary } from "../types";

export type RunStatusFilter = "all" | RunRecordSummary["status"];
export type RunSourceFilter = "all" | RunRecordSummary["source"];

export function filterRuns(
  runs: readonly RunRecordSummary[],
  filters: { query: string; status: RunStatusFilter; source: RunSourceFilter },
): RunRecordSummary[] {
  const query = filters.query.trim().toLowerCase();
  return runs.filter((run) => {
    if (filters.status !== "all" && run.status !== filters.status) return false;
    if (filters.source !== "all" && run.source !== filters.source) return false;
    if (!query) return true;
    const labels = Object.entries(run.labels ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    return [
      run.runId,
      run.source,
      run.status,
      run.sessionId ?? "",
      run.error?.code ?? "",
      run.error?.message ?? "",
      labels,
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

export function summarizeRuns(runs: readonly RunRecordSummary[]): {
  active: number;
  succeeded: number;
  failed: number;
  totalCostUsd: number;
} {
  return {
    active: runs.filter((run) => run.status === "queued" || run.status === "running" || run.status === "waiting")
      .length,
    succeeded: runs.filter((run) => run.status === "succeeded").length,
    failed: runs.filter((run) => run.status === "failed").length,
    totalCostUsd: runs.reduce(
      (total, run) => total + (typeof run.costUsd === "number" && Number.isFinite(run.costUsd) ? run.costUsd : 0),
      0,
    ),
  };
}
