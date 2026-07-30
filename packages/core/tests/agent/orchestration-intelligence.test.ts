import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEngineeringGraphHealthReport } from "../../src/agent/graph-health.js";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import type { LoopState } from "../../src/agent/loop-state.js";
import {
  analyzeLoopStrategyIntelligence,
  buildEngineeringGraphOptimizationReport,
  buildOrchestrationPortfolioReport,
  evaluateOrchestrationSlo,
  graphOrchestrationFingerprint,
  loopOrchestrationFingerprint,
  loopSloObservations,
} from "../../src/agent/orchestration-intelligence.js";

const loopState = (): LoopState => ({
  loopId: "strategy-loop",
  task: "repair",
  workspace: "/workspace",
  verifyCommand: "pnpm test",
  maxIterations: 4,
  costBudgetUsd: 2,
  tokenBudget: 2_000,
  maxDurationMs: 10_000,
  iterations: 2,
  costUsd: 0.4,
  tokensUsed: 400,
  elapsedMs: 2_000,
  sessionId: "session",
  lastVerify: null,
  status: "running",
  snapshots: [
    {
      iteration: 0,
      ts: "2026-01-01T00:00:00.000Z",
      diagnosticsFingerprint: "initial",
      workspaceFingerprint: "workspace-0",
      failedTests: 3,
      stageResults: [],
      failureCategory: "test",
      editModel: "must-not-count",
    },
    {
      iteration: 1,
      ts: "2026-01-01T00:01:00.000Z",
      diagnosticsFingerprint: "one",
      workspaceFingerprint: "workspace-1",
      failedTests: 2,
      stageResults: [],
      failureCategory: "test",
      editModel: "model-a",
      modelRouteReason: "category",
      costUsd: 0.2,
      durationMs: 1_000,
    },
    {
      iteration: 2,
      ts: "2026-01-01T00:02:00.000Z",
      diagnosticsFingerprint: "two",
      workspaceFingerprint: "workspace-2",
      failedTests: 1,
      stageResults: [],
      failureCategory: "test",
      editModel: "model-a",
      modelRouteReason: "category",
      costUsd: 0.2,
      durationMs: 1_000,
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:02:00.000Z",
});

describe("orchestration decision intelligence", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("learns only from executed Loop strategy generations", () => {
    const report = analyzeLoopStrategyIntelligence(loopState());
    expect(report.samples).toBe(2);
    expect(report.routes).toEqual([
      expect.objectContaining({ model: "model-a", attempts: 2, improvements: 2, improvementRate: 1 }),
    ]);
    expect(report.routes[0]!.lowerConfidenceBound).toBeGreaterThan(0);
    expect(report.routes[0]!.lowerConfidenceBound).toBeLessThan(1);
    expect(report.recommendedRoutes).toEqual([
      { failureCategory: "test", model: "model-a", confidence: "low", evidenceCount: 2 },
    ]);
  });

  it("fingerprints the full durable Loop generation even when timestamps collide", () => {
    const state = loopState();
    expect(loopOrchestrationFingerprint({ ...state, costUsd: state.costUsd + 1 })).not.toBe(
      loopOrchestrationFingerprint(state),
    );
    const withEvidence = {
      ...state,
      snapshots: [
        ...state.snapshots!.slice(0, -1),
        {
          ...state.snapshots!.at(-1)!,
          stageResults: [
            {
              id: "test",
              command: "pnpm test",
              code: 1,
              output: "one failure",
              attempts: 1,
              flaky: false,
              durationMs: 10,
            },
          ],
        },
      ],
    };
    const changedEvidence = {
      ...withEvidence,
      snapshots: [
        ...withEvidence.snapshots.slice(0, -1),
        {
          ...withEvidence.snapshots.at(-1)!,
          stageResults: [
            {
              id: "test",
              command: "pnpm test",
              code: 1,
              output: "two failures",
              attempts: 1,
              flaky: false,
              durationMs: 10,
            },
          ],
        },
      ],
    };
    expect(loopOrchestrationFingerprint(changedEvidence)).not.toBe(loopOrchestrationFingerprint(withEvidence));
  });

  it("fingerprints Graph checkpoint progress independently of its definition generation", () => {
    const state = {
      schemaVersion: 2,
      graphId: "fingerprint-graph",
      fingerprint: "a".repeat(64),
      status: "running",
      definition: { graphId: "fingerprint-graph", nodes: [] },
      results: [],
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
    } satisfies EngineeringGraphState;
    expect(graphOrchestrationFingerprint({ ...state, controlSeq: state.controlSeq + 1 })).not.toBe(
      graphOrchestrationFingerprint(state),
    );
  });

  it("attributes an edit to the preceding failure category and reports measured SLO coverage", () => {
    const state = loopState();
    state.verificationPlan = [
      { id: "test", command: "pnpm test" },
      { id: "lint", command: "pnpm lint" },
    ];
    state.snapshots![1] = {
      ...state.snapshots![1]!,
      failureCategory: "compile",
      durationMs: 100,
    };
    state.snapshots![2] = {
      ...state.snapshots![2]!,
      failureCategory: "none",
      durationMs: 10_000,
    };
    const strategy = analyzeLoopStrategyIntelligence(state);
    expect(strategy.routes.map((route) => route.failureCategory)).toEqual(["compile", "test"]);
    expect(
      loopSloObservations(state, {
        loopId: state.loopId,
        generatedAt: state.updatedAt,
        status: "healthy",
        progress: { iterations: 2, maxIterations: 4, remainingIterations: 2, completionRatio: 0.5 },
        usage: { costUsd: 0.4, tokensUsed: 400, elapsedMs: 2_000, verifyRuns: 2 },
        forecast: {
          samples: 2,
          nextIterationCostUsd: 0.2,
          nextIterationTokens: 200,
          nextIterationDurationMs: 50_000,
          nextIterationVerifyRuns: 1,
          affordableIterations: 2,
        },
        verification: [
          {
            stageId: "test",
            confidence: "low",
            failureRate: 0,
            flakyRate: 0,
            ageWeight: 1,
            recommendedAttempts: 1,
            quarantineCandidate: false,
          },
        ],
        findings: [],
      }),
    ).toMatchObject({ p95DurationMs: 10_000, forecastCoverage: 0.5 });
  });

  it("evaluates finite SLO boundaries without changing hard budgets", () => {
    expect(
      evaluateOrchestrationSlo(
        { p95DurationMs: 950, costUsd: 2, failureRate: 0.1, forecastCoverage: 0.8 },
        { maxP95DurationMs: 1_000, maxCostUsd: 1, maxFailureRate: 0.2, minForecastCoverage: 0.9 },
      ),
    ).toMatchObject({
      status: "breached",
      objectives: [
        { kind: "p95_duration", status: "at_risk" },
        { kind: "cost", status: "breached" },
        { kind: "failure_rate", status: "met" },
        { kind: "forecast_coverage", status: "breached" },
      ],
    });
    expect(() => evaluateOrchestrationSlo({}, { maxFailureRate: Number.NaN })).toThrow(/rate targets/);
    expect(evaluateOrchestrationSlo({ failureRate: 0 }, { maxFailureRate: 0 })).toMatchObject({
      status: "met",
      objectives: [{ kind: "failure_rate", status: "met", observed: 0, target: 0 }],
    });
  });

  it("builds bounded Pareto scenarios and validates remote placement", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-orchestration-intelligence-"));
    workspaces.push(workspace);
    for (const child of ["one", "two", "remote"]) mkdirSync(join(workspace, child));
    const state = await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "optimize",
        maxConcurrency: 2,
        nodes: [
          { id: "one", kind: "function", handler: "work", workspace: "one", resources: ["cpu"] },
          { id: "two", kind: "function", handler: "work", workspace: "two", resources: ["cpu"] },
          {
            id: "ship",
            kind: "remote",
            executor: "trusted",
            workspace: "remote",
            requiresCancellation: true,
          },
        ],
      },
      {
        workspace,
        handlers: { work: () => ({}) },
        executors: {
          trusted: {
            trusted: true,
            locality: "remote",
            protocolVersion: 1,
            supportsCancellation: true,
            execute: () => ({}),
          },
        },
      },
    );
    const observations = state.definition.nodes.map((node) => ({
      graphId: state.graphId,
      nodeId: node.id,
      fingerprint: state.fingerprint,
      durationMs: 100,
      passed: true,
      recordedAt: state.completedAt!,
    }));
    const health = buildEngineeringGraphHealthReport(state, observations);
    const report = buildEngineeringGraphOptimizationReport(state, health, {
      trusted: {
        trusted: true,
        locality: "remote",
        protocolVersion: 1,
        supportsCancellation: true,
        capacity: 1,
        active: 1,
        execute: () => ({}),
      },
      alternate: {
        trusted: true,
        locality: "remote",
        protocolVersion: 1,
        supportsCancellation: true,
        capacity: 4,
        active: 1,
        execute: () => ({}),
      },
      malformed: {
        trusted: true,
        locality: "remote",
        queueDepth: -1,
        execute: () => ({}),
      },
    });
    expect(report.scenarios.length).toBeLessThanOrEqual(16);
    expect(report.scenarios.some((scenario) => scenario.paretoOptimal)).toBe(true);
    expect(report.placements).toEqual([
      expect.objectContaining({
        nodeId: "ship",
        executor: "trusted",
        status: "capacity_exhausted",
        recommendedExecutor: "alternate",
      }),
    ]);
    expect(report.proposals).toContainEqual(
      expect.objectContaining({ action: { kind: "executor_placement", nodeId: "ship", executor: "alternate" } }),
    );
    expect(report.uncertainty.samples).toBe(128);
    expect(report.placements[0]!.alternatives.some((candidate) => candidate.executor === "malformed")).toBe(false);
  });

  it("does not double-count child Graph usage in randomized portfolio rollups", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rootCost = seed / 10;
      const childCost = seed / 20;
      const root = {
        schemaVersion: 2 as const,
        graphId: `root-${seed}`,
        fingerprint: "a".repeat(64),
        status: "passed" as const,
        definition: { graphId: `root-${seed}`, nodes: [] },
        results: [],
        events: [],
        spentCost: rootCost,
        spentTokens: seed * 10,
        elapsedMs: seed * 100,
        activeAttempts: [],
        controlSeq: 0,
        controlRunId: "run",
        priority: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const child = {
        ...root,
        graphId: `child-${seed}`,
        definition: { graphId: `child-${seed}`, nodes: [] },
        spentCost: childCost,
        parentGraph: { graphId: root.graphId, nodeId: "nested" },
      };
      expect(buildOrchestrationPortfolioReport([], [root, child]).totals.costUsd).toBe(rootCost);
    }
  });

  it("does not double-count Graph-owned Loop usage", () => {
    const root = loopState();
    const child = {
      ...loopState(),
      loopId: "child-loop",
      costUsd: 1,
      parentGraph: { graphId: "graph", nodeId: "repair" },
    };
    const graph = {
      schemaVersion: 2 as const,
      graphId: "graph",
      fingerprint: "a".repeat(64),
      status: "passed" as const,
      definition: { graphId: "graph", nodes: [] },
      results: [],
      events: [],
      spentCost: child.costUsd,
      spentTokens: 0,
      elapsedMs: 0,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "run",
      priority: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(buildOrchestrationPortfolioReport([root, child], [graph]).totals.costUsd).toBe(
      root.costUsd + graph.spentCost,
    );
    expect(buildOrchestrationPortfolioReport([root, child], [graph]).items.at(-1)).toMatchObject({
      id: "strategy-loop",
    });
    expect(buildOrchestrationPortfolioReport([child], []).totals.costUsd).toBe(child.costUsd);
  });
});
