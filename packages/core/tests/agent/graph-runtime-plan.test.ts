import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildEngineeringGraphRuntimeReplan,
  buildWorkspaceExecutorCapacityReport,
} from "../../src/agent/graph-runtime-plan.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";
import { acquireWorkspaceGraphExecutorCapacity } from "../../src/agent/graph-capacity.js";

const state: EngineeringGraphState = {
  schemaVersion: 2,
  graphId: "runtime-plan",
  fingerprint: "a".repeat(64),
  status: "running",
  definition: {
    graphId: "runtime-plan",
    nodes: [
      { id: "done", kind: "function", handler: "noop" },
      { id: "urgent", kind: "function", handler: "noop", dependsOn: ["done"], priority: 2 },
      { id: "remote", kind: "remote", executor: "worker", dependsOn: ["done"] },
      { id: "waiting", kind: "function", handler: "noop", dependsOn: ["urgent"] },
    ],
  },
  results: [{ id: "done", kind: "function", status: "passed", attempts: 1, costUsd: 0, tokensUsed: 0 }],
  events: [],
  spentCost: 0,
  spentTokens: 0,
  elapsedMs: 0,
  activeAttempts: [],
  controlSeq: 0,
  controlRunId: "run",
  priority: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("Engineering Graph runtime planning", () => {
  it("replans only unfinished nodes and explains capacity deferral", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-runtime-replan-"));
    try {
      const report = buildEngineeringGraphRuntimeReplan(workspace, state, {
        worker: { trusted: true, locality: "remote", execute: async () => ({}), capacity: 1, active: 1 },
      });
      expect(report.recommendedOrder).toEqual(["urgent"]);
      expect(report.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ nodeId: "remote", status: "deferred" }),
          expect.objectContaining({ nodeId: "waiting", status: "blocked" }),
        ]),
      );
      expect(report.entries.some((entry) => entry.nodeId === "done")).toBe(false);
      const reservation = acquireWorkspaceGraphExecutorCapacity(workspace, "worker", "runtime-replan:remote", 1)!;
      const capacityReport = buildEngineeringGraphRuntimeReplan(workspace, state, {
        worker: {
          trusted: true,
          locality: "remote",
          execute: async () => ({}),
          workspaceCapacity: 1,
        },
      });
      expect(capacityReport.entries).toContainEqual(
        expect.objectContaining({ nodeId: "remote", status: "deferred", reasons: [expect.stringMatching(/capacity/)] }),
      );
      reservation.release();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("summarizes executor assignments and live capacity", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-runtime-plan-"));
    expect(
      buildWorkspaceExecutorCapacityReport(workspace, [state], {
        worker: {
          trusted: true,
          locality: "remote",
          execute: async () => ({}),
          capacity: 4,
          active: 1,
          queueDepth: 2,
        },
      }),
    ).toEqual([expect.objectContaining({ executor: "worker", available: 3, assignedNodes: 1, utilization: 0.25 })]);
    const reservation = acquireWorkspaceGraphExecutorCapacity(workspace, "worker", "runtime-plan:remote:attempt", 1)!;
    expect(
      buildWorkspaceExecutorCapacityReport(workspace, [state], {
        worker: {
          trusted: true,
          locality: "remote",
          execute: async () => ({}),
          capacity: 4,
          workspaceCapacity: 1,
        },
      }),
    ).toEqual([expect.objectContaining({ executor: "worker", capacity: 1, active: 1, status: "capacity_exhausted" })]);
    reservation.release();
    rmSync(workspace, { recursive: true, force: true });
  });
});
