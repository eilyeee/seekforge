import { describe, expect, it } from "vitest";
import type { RunRecordSummary } from "../types";
import { filterRuns, summarizeRuns } from "./run-control";

function run(id: string, status: RunRecordSummary["status"], source: RunRecordSummary["source"], costUsd?: number) {
  return {
    runId: id,
    status,
    source,
    attempt: 1,
    workspace: "/tmp/project",
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    ...(costUsd === undefined ? {} : { costUsd }),
  } satisfies RunRecordSummary;
}

describe("run control projections", () => {
  const runs = [run("run-agent", "running", "background", 0.2), run("run-graph", "failed", "graph", 0.1)];

  it("filters by status, source, and searchable identity", () => {
    expect(filterRuns(runs, { query: "graph", status: "all", source: "all" })).toHaveLength(1);
    expect(filterRuns(runs, { query: "", status: "running", source: "background" })).toEqual([runs[0]]);
    expect(filterRuns(runs, { query: "", status: "succeeded", source: "all" })).toEqual([]);
  });

  it("summarizes active outcomes and finite cost", () => {
    const summary = summarizeRuns([...runs, run("run-bad-cost", "succeeded", "ws", Number.NaN)]);
    expect(summary).toMatchObject({
      active: 1,
      succeeded: 1,
      failed: 1,
    });
    expect(summary.totalCostUsd).toBeCloseTo(0.3);
  });
});
