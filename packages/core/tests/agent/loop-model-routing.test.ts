import { describe, expect, it } from "vitest";
import type { LoopIterationSnapshot } from "../../src/agent/auto-loop.js";
import { selectLoopModelRoute, validateLoopModelRoutes } from "../../src/agent/loop-model-routing.js";

const snapshot = (failureCategory: LoopIterationSnapshot["failureCategory"]): LoopIterationSnapshot => ({
  iteration: 0,
  ts: "2026-01-01T00:00:00.000Z",
  diagnosticsFingerprint: "diagnostic",
  workspaceFingerprint: null,
  failedTests: failureCategory === "none" ? 0 : 1,
  stageResults: [],
  failureCategory,
});

describe("Loop model routing", () => {
  it("escalates only through the explicit category chain after bounded failure windows", () => {
    const route = selectLoopModelRoute({
      category: "compile",
      snapshots: [snapshot("test"), snapshot("compile"), snapshot("compile"), snapshot("compile")],
      defaultModel: "base",
      candidates: ["fast", "strong"],
      escalationThreshold: 2,
    });
    expect(route).toEqual({
      model: "strong",
      category: "compile",
      consecutiveFailures: 3,
      candidateIndex: 1,
      reason: "escalated_category",
    });
  });

  it("lets an exact static category route override an escalation chain", () => {
    expect(
      selectLoopModelRoute({
        category: "test",
        snapshots: [snapshot("test"), snapshot("test")],
        defaultModel: "base",
        staticModel: "test-owner",
        candidates: ["fast", "strong"],
        escalationThreshold: 1,
      }),
    ).toMatchObject({ model: "test-owner", reason: "static_category", candidateIndex: 0 });
  });

  it("falls back to the configured default without inventing a model", () => {
    expect(
      selectLoopModelRoute({
        category: "unknown",
        snapshots: [],
        defaultModel: "base",
        escalationThreshold: 2,
      }),
    ).toEqual({
      model: "base",
      category: "unknown",
      consecutiveFailures: 0,
      candidateIndex: 0,
      reason: "default",
    });
  });

  it("owns bounded route validation and rejects invalid policy inputs", () => {
    expect(validateLoopModelRoutes({ compile: ["fast", "strong"], test: ["strong"] })).toEqual(["fast", "strong"]);
    expect(() => validateLoopModelRoutes({ compile: ["fast", "fast"] })).toThrow(/invalid/);
    expect(() => validateLoopModelRoutes({})).toThrow(/at least one/);
    expect(() =>
      selectLoopModelRoute({ category: "test", snapshots: [], candidates: ["fast"], escalationThreshold: 0 }),
    ).toThrow(/threshold/);
  });
});
