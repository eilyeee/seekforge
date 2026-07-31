import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";
import type { EngineeringGraphDistributionReport } from "../../src/agent/graph-simulation.js";
import {
  buildWorkspaceOrchestrationControlAnalytics,
  listOrchestrationControlObservations,
  recordEngineeringGraphForecastObservation,
  recordOrchestrationDeploymentObservation,
} from "../../src/agent/orchestration-control.js";
import type { OrchestrationDeployment } from "../../src/agent/orchestration-deployments.js";

describe("orchestration control analytics", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-control-"));
    workspaces.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("deduplicates deployment evidence and derives global burn rate", () => {
    const root = workspace();
    const now = "2026-01-01T12:00:00.000Z";
    const deployment: OrchestrationDeployment = {
      proposalId: `opt-${"1".repeat(20)}`,
      proposalUpdatedAt: now,
      scope: "loop",
      sourceId: "loop",
      sourceFingerprint: "a".repeat(64),
      action: { kind: "loop_route", failureCategory: "test", model: "model" },
      status: "applied",
      attempt: 1,
      startedAt: now,
      updatedAt: now,
      baseline: { costPerUnit: 1, durationPerUnitMs: 100, failures: 0, terminal: false },
      observed: { costPerUnit: 1, durationPerUnitMs: 100, failures: 0, terminal: true },
      verdict: "stable",
    };
    recordOrchestrationDeploymentObservation(root, deployment);
    recordOrchestrationDeploymentObservation(root, deployment);
    recordOrchestrationDeploymentObservation(root, {
      ...deployment,
      proposalId: `opt-${"2".repeat(20)}`,
      observed: { ...deployment.observed!, failures: 1 },
      verdict: "regressed",
    });
    recordOrchestrationDeploymentObservation(root, { ...deployment, attempt: 2 });
    expect(listOrchestrationControlObservations(root).observations).toHaveLength(3);
    const burnRate = buildWorkspaceOrchestrationControlAnalytics(root, {
      maxBreachRate: 0.1,
      now: new Date(now),
    }).burnRates[0]!;
    expect(burnRate).toMatchObject({ samples: 3, breaches: 1, status: "critical" });
    expect(burnRate.burnRate).toBeCloseTo(10 / 3);
  });

  it("records exact-generation forecast calibration", () => {
    const root = workspace();
    const state: EngineeringGraphState = {
      schemaVersion: 2,
      graphId: "calibration",
      fingerprint: "b".repeat(64),
      status: "passed",
      definition: { graphId: "calibration", maxDurationMs: 1_000, nodes: [] },
      results: [],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      elapsedMs: 900,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "run",
      priority: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    };
    const forecast: EngineeringGraphDistributionReport = {
      graphId: state.graphId,
      samples: 100,
      makespanMs: { p50: 800, p95: 1_000, p99: 1_100 },
      activeDurationMs: { p50: 800, p95: 1_000, p99: 1_100 },
      durationBreachProbability: 0.2,
      deadlineBreachProbability: 0,
      budgetBreachProbability: 0,
      sensitivity: [],
    };
    recordEngineeringGraphForecastObservation(root, state, forecast);
    recordEngineeringGraphForecastObservation(root, state, forecast);
    recordEngineeringGraphForecastObservation(
      root,
      { ...state, status: "cancelled", controlRunId: "run-two", elapsedMs: 1_100 },
      forecast,
    );
    expect(recordEngineeringGraphForecastObservation(root, { ...state, controlRunId: "" }, forecast)).toBeUndefined();
    recordEngineeringGraphForecastObservation(
      root,
      {
        ...state,
        controlRunId: "future-run",
        completedAt: "2099-01-01T00:00:00.000Z",
        updatedAt: "2099-01-01T00:00:00.000Z",
      },
      forecast,
    );
    const calibration = buildWorkspaceOrchestrationControlAnalytics(root, {
      now: new Date("2026-01-01T12:00:00.000Z"),
    }).calibration;
    expect(calibration).toMatchObject({ samples: 2, meanAbsoluteErrorMs: 200, p95Coverage: 0.5 });
    expect(calibration.brierScore).toBeCloseTo(0.34);
  });
});
