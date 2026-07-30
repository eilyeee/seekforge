import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import { buildEngineeringGraphHealthReport } from "../../src/agent/graph-health.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

describe("Engineering Graph health", () => {
  it("reports unknown health when the current fingerprint has no observations", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        { graphId: "unknown-health", nodes: [{ id: "build", kind: "function", handler: "build" }] },
        { workspace, handlers: { build: () => ({}) } },
      );
      expect(buildEngineeringGraphHealthReport(state, [])).toMatchObject({
        status: "unknown",
        nodes: [{ nodeId: "build", samples: 0, confidence: "none" }],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("joins current-fingerprint forecasts, runtime drift, and child lineage", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        { graphId: "health", nodes: [{ id: "build", kind: "function", handler: "build" }] },
        { workspace, handlers: { build: () => ({}) } },
      );
      const completed = state.results[0]!;
      const actual = Date.parse(completed.completedAt!) - Date.parse(completed.startedAt!);
      const report = buildEngineeringGraphHealthReport(state, [
        {
          graphId: "health",
          nodeId: "build",
          fingerprint: state.fingerprint,
          durationMs: Math.max(1, actual),
          predictedDurationMs: 1,
          resourceWaitMs: 2,
          passed: true,
          recordedAt: completed.completedAt!,
        },
        {
          graphId: "health",
          nodeId: "build",
          fingerprint: "f".repeat(64),
          durationMs: 999_999,
          passed: false,
          recordedAt: completed.completedAt!,
        },
      ]);
      expect(report).toMatchObject({
        graphId: "health",
        status: "healthy",
        criticalPath: ["build"],
        nodes: [
          expect.objectContaining({
            nodeId: "build",
            samples: 1,
            averageResourceWaitMs: 2,
            forecastDriftMs: actual - 1,
          }),
        ],
      });
      expect(report.predictedMakespanMs).toBe(Math.max(1, actual));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
