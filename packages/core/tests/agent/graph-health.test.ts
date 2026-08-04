import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import { buildEngineeringGraphHealthReport } from "../../src/agent/graph-health.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

/**
 * Durable-engine suite: every state transition is an atomic write with two
 * fsyncs, which on a slow filesystem puts a single run at hundreds of
 * milliseconds and a multi-run test past Vitest's 5s default. See the note in
 * graph-engineering.test.ts for the measurement. Headroom, not a hang
 * workaround.
 */
vi.setConfig({ testTimeout: 30_000 });

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
      expect(report.predictedP95MakespanMs).toBe(Math.max(1, actual));
      expect(report.forecastCoverage).toEqual({ measuredNodes: 1, totalNodes: 1, ratio: 1 });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("compares bounded capacity improvements against the P50 baseline", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      const firstWorkspace = join(workspace, "first");
      const secondWorkspace = join(workspace, "second");
      mkdirSync(firstWorkspace);
      mkdirSync(secondWorkspace);
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        {
          graphId: "capacity-health",
          maxConcurrency: 2,
          nodes: [
            { id: "first", kind: "function", handler: "work", resources: ["cpu"], workspace: "first" },
            { id: "second", kind: "function", handler: "work", resources: ["cpu"], workspace: "second" },
          ],
        },
        { workspace, handlers: { work: () => ({}) } },
      );
      const recordedAt = state.completedAt!;
      const report = buildEngineeringGraphHealthReport(
        state,
        [
          {
            graphId: state.graphId,
            nodeId: "first",
            fingerprint: state.fingerprint,
            durationMs: 100,
            passed: true,
            recordedAt,
          },
          {
            graphId: state.graphId,
            nodeId: "second",
            fingerprint: state.fingerprint,
            durationMs: 300,
            passed: true,
            recordedAt,
          },
        ],
        new Date(recordedAt),
      );
      expect(report).toMatchObject({
        predictedMakespanMs: 400,
        predictedP95MakespanMs: 400,
        forecastCoverage: { measuredNodes: 2, totalNodes: 2, ratio: 1 },
        recommendations: [
          {
            kind: "resource_capacity",
            target: "cpu",
            currentValue: 1,
            suggestedValue: 2,
            predictedSavingsMs: 100,
          },
        ],
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not recommend concurrency that would invalidate shared workspaces", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        {
          graphId: "shared-workspace-health",
          nodes: [
            { id: "first", kind: "function", handler: "work" },
            { id: "second", kind: "function", handler: "work" },
          ],
        },
        { workspace, handlers: { work: () => ({}) } },
      );
      const recordedAt = state.completedAt!;
      const observations = state.definition.nodes.map((node, index) => ({
        graphId: state.graphId,
        nodeId: node.id,
        fingerprint: state.fingerprint,
        durationMs: index === 0 ? 100 : 300,
        passed: true,
        recordedAt,
      }));
      expect(buildEngineeringGraphHealthReport(state, observations).recommendations).not.toContainEqual(
        expect.objectContaining({ kind: "max_concurrency" }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("recommends feasible concurrency increases from an already isolated graph", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      for (const name of ["first", "second", "third"]) mkdirSync(join(workspace, name));
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        {
          graphId: "isolated-concurrency-health",
          maxConcurrency: 2,
          nodes: ["first", "second", "third"].map((id) => ({
            id,
            kind: "function" as const,
            handler: "work",
            workspace: id,
          })),
        },
        { workspace, handlers: { work: () => ({}) } },
      );
      const recordedAt = state.completedAt!;
      const observations = state.definition.nodes.map((node) => ({
        graphId: state.graphId,
        nodeId: node.id,
        fingerprint: state.fingerprint,
        durationMs: 100,
        passed: true,
        recordedAt,
      }));
      expect(buildEngineeringGraphHealthReport(state, observations).recommendations).toContainEqual({
        kind: "max_concurrency",
        target: "maxConcurrency",
        currentValue: 2,
        suggestedValue: 3,
        predictedSavingsMs: 100,
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not recommend a new resource capacity beyond the definition key limit", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-health-"));
    try {
      mkdirSync(join(workspace, "first"));
      mkdirSync(join(workspace, "second"));
      const resourceCapacities = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`slot${index}`, 1]));
      const state = await runEngineeringGraph(
        {} as AgentCoreDeps,
        {
          graphId: "capacity-key-limit-health",
          maxConcurrency: 2,
          resourceCapacities,
          nodes: [
            { id: "first", kind: "function", handler: "work", resources: ["cpu"], workspace: "first" },
            { id: "second", kind: "function", handler: "work", resources: ["cpu"], workspace: "second" },
          ],
        },
        { workspace, handlers: { work: () => ({}) } },
      );
      const recordedAt = state.completedAt!;
      const observations = state.definition.nodes.map((node, index) => ({
        graphId: state.graphId,
        nodeId: node.id,
        fingerprint: state.fingerprint,
        durationMs: index === 0 ? 100 : 300,
        passed: true,
        recordedAt,
      }));
      expect(buildEngineeringGraphHealthReport(state, observations).recommendations).not.toContainEqual(
        expect.objectContaining({ kind: "resource_capacity", target: "cpu" }),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
