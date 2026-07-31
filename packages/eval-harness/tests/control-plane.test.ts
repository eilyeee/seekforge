import { describe, expect, it } from "vitest";
import { defaultControlPlaneScenarios, evaluateControlPlaneScenarios } from "../src/control-plane.js";

describe("longitudinal control-plane evaluation", () => {
  it("compares sequential recovery, time, and cost", () => {
    const report = evaluateControlPlaneScenarios(defaultControlPlaneScenarios());
    expect(report.scenarios[0]).toMatchObject({ samples: 4, verdict: "improved" });
    expect(report.scenarios[0]!.controlledRecoveryRate).toBeGreaterThan(report.scenarios[0]!.baselineRecoveryRate);
  });

  it("rejects unordered longitudinal samples", () => {
    const scenario = defaultControlPlaneScenarios()[0]!;
    expect(() =>
      evaluateControlPlaneScenarios([{ ...scenario, observations: [...scenario.observations].reverse() }]),
    ).toThrow(/strictly increasing/);
  });

  it("rejects non-boolean recovery outcomes from untrusted JSON", () => {
    const scenario = structuredClone(defaultControlPlaneScenarios()[0]!) as unknown as {
      observations: Array<Record<string, unknown>>;
    };
    scenario.observations[0]!.baseline = { recovered: "yes", recoveryMs: 1, costUsd: 1 };
    expect(() => evaluateControlPlaneScenarios([scenario as never])).toThrow(/boolean recovery/);
  });

  it("rejects malformed scenario containers from untrusted JSON", () => {
    expect(() => evaluateControlPlaneScenarios(null as never)).toThrow(/must be an array/);
    expect(() => evaluateControlPlaneScenarios([{ id: 7, observations: [] } as never])).toThrow(/ids/);
    expect(() => evaluateControlPlaneScenarios([{ id: "bad-shape", observations: {} } as never])).toThrow(
      /observations must be an array/,
    );
  });
});
