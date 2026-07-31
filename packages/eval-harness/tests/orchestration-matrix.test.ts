import { describe, expect, it } from "vitest";
import {
  buildOrchestrationEvaluationMatrix,
  compareOrchestrationEvaluationMatrices,
  evaluateOrchestrationEvaluationDrift,
  type OrchestrationEvalObservation,
} from "../src/orchestration-matrix.js";

const observation = (
  runId: string,
  overrides: Partial<OrchestrationEvalObservation> = {},
): OrchestrationEvalObservation => ({
  runId,
  ecosystem: "node",
  execution: "local",
  fault: "none",
  passed: true,
  predictedP95Ms: 1_000,
  predictedBreachProbability: 0.1,
  actualDurationMs: 900,
  breached: false,
  costUsd: 1,
  ...overrides,
});

describe("orchestration evaluation matrix", () => {
  it("aggregates raw runs, calibration, and missing real-project cells", () => {
    const report = buildOrchestrationEvaluationMatrix(
      [observation("one"), observation("two", { passed: false, actualDurationMs: 1_200, breached: true, costUsd: 3 })],
      [
        { ecosystem: "node", execution: "local", fault: "none" },
        { ecosystem: "rust", execution: "remote", fault: "crash_recovery" },
      ],
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(report).toMatchObject({
      generatedAt: "2026-01-01T00:00:00.000Z",
      samples: 2,
      cells: [expect.objectContaining({ samples: 2, passRate: 0.5, meanCostUsd: 2, p95Coverage: 0.5 })],
      missing: [{ ecosystem: "rust", execution: "remote", fault: "crash_recovery" }],
    });
    expect(report.cells[0]?.brierScore).toBeCloseTo(0.41);
  });

  it("reports drift only for comparable cells and rejects duplicate runs", () => {
    const baseline = buildOrchestrationEvaluationMatrix([observation("base")]);
    const current = buildOrchestrationEvaluationMatrix([
      observation("current", { passed: false, costUsd: 2, predictedBreachProbability: 0.8, breached: true }),
    ]);
    expect(compareOrchestrationEvaluationMatrices(current, baseline)).toEqual([
      expect.objectContaining({ passRateDelta: -1, meanCostUsdDelta: 1 }),
    ]);
    expect(evaluateOrchestrationEvaluationDrift(current, baseline, { minimumSamples: 1 })).toMatchObject({
      passed: false,
      violations: [expect.objectContaining({ baselineSamples: 1, currentSamples: 1, passRateDelta: -1 })],
    });
    expect(evaluateOrchestrationEvaluationDrift(current, baseline, { minimumSamples: 2 }).violations).toEqual([]);
    expect(() => buildOrchestrationEvaluationMatrix([observation("same"), observation("same")])).toThrow(/duplicate/);
  });
});
