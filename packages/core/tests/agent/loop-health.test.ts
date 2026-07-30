import { describe, expect, it } from "vitest";
import type { LoopIterationSnapshot } from "../../src/agent/auto-loop.js";
import { forecastLoopBudgetUsage } from "../../src/agent/loop-budget-policy.js";
import { buildLoopHealthReport } from "../../src/agent/loop-health.js";
import type { LoopState } from "../../src/agent/loop-state.js";
import type { LoopVerificationIntelligence } from "../../src/agent/loop-verification-intelligence.js";

const snapshot = (iteration: number): LoopIterationSnapshot => ({
  iteration,
  ts: `2026-01-0${iteration}T00:00:00.000Z`,
  diagnosticsFingerprint: `diag-${iteration}`,
  workspaceFingerprint: `workspace-${iteration}`,
  failedTests: 1,
  stageResults: [
    {
      id: "verify",
      command: "pnpm test",
      code: 0,
      output: "",
      attempts: 2,
      flaky: true,
      durationMs: 1_000,
    },
  ],
  durationMs: 1_000,
  costUsd: 0.2,
  tokensUsed: 100,
});

const state = (overrides: Partial<LoopState> = {}): LoopState => ({
  loopId: "health-loop",
  task: "repair",
  workspace: "/workspace",
  verifyCommand: "pnpm test",
  maxIterations: 4,
  costBudgetUsd: 1,
  iterations: 2,
  costUsd: 0.85,
  tokensUsed: 200,
  verifyRuns: 2,
  elapsedMs: 2_000,
  sessionId: "session",
  lastVerify: null,
  status: "running",
  snapshots: [snapshot(1), snapshot(2)],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const intelligence: LoopVerificationIntelligence = {
  stageId: "verify",
  command: "pnpm test",
  runtimeFingerprint: "runtime",
  samples: 8,
  passes: 7,
  failures: 1,
  flakyRuns: 5,
  consecutiveFailures: 0,
  averageDurationMs: 500,
  lastCode: 0,
  lastFailureCategory: "none",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("Loop health", () => {
  it("joins budget burn, affordable iterations, and exact-stage reliability", () => {
    const report = buildLoopHealthReport(state(), [intelligence], new Date("2026-01-03T00:00:00.000Z"));
    expect(report).toMatchObject({
      status: "critical",
      progress: { remainingIterations: 2, completionRatio: 0.5 },
      usage: { remainingCostUsd: 0.15 },
      forecast: {
        samples: 2,
        nextIterationCostUsd: 0.2,
        nextIterationVerifyRuns: 2,
        affordableIterations: 0,
        limitingBudget: "cost",
      },
      verification: [{ stageId: "verify", recommendedAttempts: 3, quarantineCandidate: true }],
    });
    expect(report.findings.map((finding) => finding.kind)).toEqual(["budget_risk", "verification_instability"]);
  });

  it("reports critical terminal failure and unknown health without evidence", () => {
    const failed = buildLoopHealthReport(state({ status: "no_progress", iterations: 4 }), []);
    expect(failed.status).toBe("critical");
    expect(failed.findings).toContainEqual(expect.objectContaining({ kind: "terminal_failure", severity: "critical" }));
    expect(
      buildLoopHealthReport(
        state({ iterations: 0, costUsd: 0, tokensUsed: 0, verifyRuns: 0, elapsedMs: 0, snapshots: [] }),
        [],
      ).status,
    ).toBe("unknown");
  });

  it("counts verifier retry attempts in the next-iteration budget forecast", () => {
    const report = buildLoopHealthReport(
      state({ costBudgetUsd: null, verifyRuns: 2, maxVerifyRuns: 4 }),
      [],
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(report.forecast).toMatchObject({
      nextIterationVerifyRuns: 2,
      affordableIterations: 0,
      limitingBudget: "verify_runs",
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ kind: "budget_risk", message: expect.stringContaining("verify_runs") }),
    );
  });

  it("reports zero capacity when a hard budget is exhausted without forecast samples", () => {
    const report = buildLoopHealthReport(
      state({ iterations: 1, costUsd: 1, snapshots: [] }),
      [],
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(report.forecast).toMatchObject({ samples: 0, affordableIterations: 0, limitingBudget: "cost" });
    expect(report.findings).toContainEqual(expect.objectContaining({ kind: "budget_risk", severity: "critical" }));
  });

  it("saturates verifier-attempt aggregation at the safe integer boundary", () => {
    const overloaded = snapshot(1);
    overloaded.stageResults = [
      { ...overloaded.stageResults[0]!, attempts: Number.MAX_SAFE_INTEGER },
      { ...overloaded.stageResults[0]!, id: "lint", attempts: Number.MAX_SAFE_INTEGER },
    ];
    expect(forecastLoopBudgetUsage([overloaded]).verifyRuns).toBe(Number.MAX_SAFE_INTEGER);
  });
});
