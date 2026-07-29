import { describe, expect, it } from "vitest";
import { explainEngineeringGraphNode, simulateEngineeringGraph } from "../../src/agent/graph-simulation.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";

describe("Engineering Graph simulation", () => {
  it("models concurrency, hierarchical resources, and the duration critical path", () => {
    const report = simulateEngineeringGraph(
      {
        graphId: "forecast",
        maxConcurrency: 2,
        nodes: [
          { id: "a", kind: "function", handler: "noop", resources: ["provider"] },
          { id: "b", kind: "function", handler: "noop", resources: ["provider.deepseek"] },
          { id: "c", kind: "function", handler: "noop", dependsOn: ["a"] },
        ],
      },
      {
        estimates: {
          a: { durationMs: 10, costUsd: 1, tokens: 10 },
          b: { durationMs: 5, costUsd: 2, tokens: 20 },
          c: { durationMs: 2, costUsd: 3, tokens: 30 },
        },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    expect(report.makespanMs).toBe(15);
    expect(report.estimatedCostUsd).toBe(6);
    expect(report.estimatedTokens).toBe(60);
    expect(report.criticalPath).toEqual(["a", "c"]);
    expect(report.bottlenecks).toEqual(["b"]);
    expect(report.nodes.find((node) => node.id === "b")?.resourceWaitMs).toBe(10);
  });

  it("reports budget, deadline, gate, signal, retry, and compensation risks", () => {
    const report = simulateEngineeringGraph(
      {
        graphId: "risks",
        maxDurationMs: 5,
        costBudgetUsd: 1,
        tokenBudget: 1,
        nodes: [
          { id: "work", kind: "function", handler: "noop", maxRetries: 1, deadlineAt: "2025-01-01T00:00:00.000Z" },
          { id: "gate", kind: "gate", dependsOn: ["work"] },
          { id: "signal", kind: "wait", dependsOn: ["gate"], waitFor: { signal: "ready" } },
          { id: "undo", kind: "compensation", handler: "noop", dependsOn: ["work"], compensates: ["work"] },
        ],
      },
      {
        retryMode: "worst_case",
        estimates: { work: { durationMs: 4, costUsd: 2, tokens: 2 } },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );
    expect(report.makespanMs).toBe(8);
    expect(report.estimatedCostUsd).toBe(4);
    expect(report.estimatedTokens).toBe(4);
    expect(report.contingencyNodes).toEqual(["undo"]);
    expect(report.risks.join(" ")).toMatch(/duration.*cost.*tokens.*deadline.*approval.*external signal/i);
  });

  it("validates estimates instead of coercing transport values", () => {
    expect(() =>
      simulateEngineeringGraph(
        { graphId: "invalid-estimate", nodes: [{ id: "one", kind: "function", handler: "noop" }] },
        { estimates: { one: { durationMs: "1" as unknown as number } } },
      ),
    ).toThrow(/duration/);
    expect(() =>
      simulateEngineeringGraph(
        { graphId: "null-estimates", nodes: [{ id: "one", kind: "function", handler: "noop" }] },
        { estimates: null as unknown as Record<string, { durationMs: number }> },
      ),
    ).toThrow(/must be an object/);
  });

  it("models an unresolved durable timer as a global scheduling barrier", () => {
    const report = simulateEngineeringGraph(
      {
        graphId: "timer",
        maxConcurrency: 2,
        nodes: [
          { id: "long", kind: "function", handler: "noop" },
          { id: "timer", kind: "wait", waitFor: { notBefore: "2026-01-01T00:00:00.005Z" } },
          { id: "after", kind: "function", handler: "noop", dependsOn: ["timer"] },
        ],
      },
      {
        estimates: { long: { durationMs: 10 }, after: { durationMs: 1 } },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );
    expect(report.nodes.find((node) => node.id === "long")).toMatchObject({ startMs: 5, resourceWaitMs: 0 });
    expect(report.nodes.find((node) => node.id === "timer")).toMatchObject({ startMs: 5, resourceWaitMs: 0 });
    expect(report.nodes.find((node) => node.id === "after")?.startMs).toBe(5);
    expect(report.makespanMs).toBe(15);
    expect(report.bottlenecks).toEqual([]);
  });

  it("keeps zero-duration dependencies in topological critical-path order", () => {
    const report = simulateEngineeringGraph({
      graphId: "zero-duration",
      nodes: [
        { id: "z-parent", kind: "gate" },
        { id: "a-child", kind: "gate", dependsOn: ["z-parent"] },
      ],
    });
    expect(report.criticalPath).toEqual(["z-parent", "a-child"]);
  });

  it("separates offline timer delay from the active duration budget", () => {
    const report = simulateEngineeringGraph(
      {
        graphId: "active-time",
        maxDurationMs: 5,
        nodes: [
          { id: "timer", kind: "wait", waitFor: { notBefore: "2026-01-01T00:00:00.100Z" } },
          { id: "work", kind: "function", handler: "noop", dependsOn: ["timer"] },
        ],
      },
      {
        estimates: { work: { durationMs: 1 } },
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    );
    expect(report).toMatchObject({ makespanMs: 101, estimatedActiveDurationMs: 1 });
    expect(report.risks.join(" ")).not.toMatch(/maxDurationMs/);
  });
});

describe("Engineering Graph node explanation", () => {
  it("explains dependency, resource, concurrency, and budget blockers", () => {
    const definition = {
      graphId: "explain",
      maxConcurrency: 1,
      costBudgetUsd: 1,
      nodes: [
        { id: "first", kind: "function" as const, handler: "noop", resources: ["repo"] },
        { id: "second", kind: "function" as const, handler: "noop", dependsOn: ["first"], resources: ["repo.code"] },
      ],
    };
    const state = {
      graphId: "explain",
      definition,
      results: [],
      activeAttempts: [{ nodeId: "first", attempt: 1, idempotencyKey: "key", startedAt: "2026-01-01T00:00:00.000Z" }],
      spentCost: 1,
      spentTokens: 0,
      elapsedMs: 0,
    } as unknown as EngineeringGraphState;

    const explanation = explainEngineeringGraphNode(definition, state, "second");
    expect(explanation.eligible).toBe(false);
    expect(explanation.blockers.map((blocker) => blocker.code)).toEqual([
      "dependency_pending",
      "concurrency_full",
      "resource_busy",
      "cost_budget_exhausted",
    ]);
  });

  it("marks manual gates in a dry explanation", () => {
    const explanation = explainEngineeringGraphNode(
      { graphId: "gate-explain", nodes: [{ id: "approve", kind: "gate" }] },
      undefined,
      "approve",
    );
    expect(explanation).toMatchObject({ eligible: false, blockers: [{ code: "approval_required" }] });
  });

  it("treats an available signal as an alternative to a pending timer", () => {
    const definition = {
      graphId: "wait-explain",
      nodes: [
        {
          id: "wait",
          kind: "wait",
          waitFor: { signal: "ready", notBefore: "2027-01-01T00:00:00.000Z" },
        },
      ],
    };
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(explainEngineeringGraphNode(definition, undefined, "wait", now).blockers.map((item) => item.code)).toEqual([
      "timer_pending",
      "signal_pending",
    ]);
    expect(explainEngineeringGraphNode(definition, undefined, "wait", now, { signalAvailable: true })).toMatchObject({
      eligible: true,
      blockers: [],
    });
  });

  it("reports an expired unresolved wait as terminally blocked", () => {
    const explanation = explainEngineeringGraphNode(
      {
        graphId: "expired-wait",
        nodes: [{ id: "wait", kind: "wait", waitFor: { signal: "ready", expiresAt: "2025-01-01T00:00:00.000Z" } }],
      },
      undefined,
      "wait",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(explanation.blockers.map((item) => item.code)).toEqual(["wait_expired"]);
  });
});
