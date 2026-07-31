export type ControlPlaneObservation = {
  day: number;
  fault: string;
  baseline: { recovered: boolean; recoveryMs: number; costUsd: number };
  controlled: { recovered: boolean; recoveryMs: number; costUsd: number };
};

export type ControlPlaneScenario = { id: string; observations: ControlPlaneObservation[] };

export type ControlPlaneScenarioResult = ControlPlaneEvalReport["scenarios"][number];
export type ControlPlaneReport = ControlPlaneEvalReport;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
}

function improvement(baseline: number, controlled: number): number {
  if (baseline === 0) return controlled === 0 ? 0 : -1;
  return (baseline - controlled) / baseline;
}

/** Evaluates sequential fault observations instead of treating tasks as isolated samples. */
export function evaluateControlPlaneScenarios(scenarios: ControlPlaneScenario[]): ControlPlaneReport {
  if (!Array.isArray(scenarios)) throw new Error("control-plane scenarios must be an array");
  if (scenarios.length < 1 || scenarios.length > 32) throw new Error("control-plane scenarios must contain 1-32 items");
  const ids = new Set<string>();
  const results = scenarios.map((scenario): ControlPlaneScenarioResult => {
    if (!record(scenario)) throw new Error("control-plane scenarios must be objects");
    if (
      typeof scenario.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(scenario.id) ||
      ids.has(scenario.id)
    ) {
      throw new Error("control-plane scenario ids must be unique and safe");
    }
    ids.add(scenario.id);
    if (!Array.isArray(scenario.observations)) {
      throw new Error(`scenario ${scenario.id} observations must be an array`);
    }
    if (scenario.observations.length < 2 || scenario.observations.length > 365) {
      throw new Error(`scenario ${scenario.id} must contain 2-365 observations`);
    }
    let previousDay = 0;
    for (const observation of scenario.observations) {
      if (
        !record(observation) ||
        !record(observation.baseline) ||
        !record(observation.controlled) ||
        typeof observation.baseline.recovered !== "boolean" ||
        typeof observation.controlled.recovered !== "boolean"
      ) {
        throw new Error(`scenario ${scenario.id} observations must contain boolean recovery outcomes`);
      }
      if (!Number.isSafeInteger(observation.day) || observation.day <= previousDay) {
        throw new Error(`scenario ${scenario.id} days must be strictly increasing positive integers`);
      }
      previousDay = observation.day;
      if (
        typeof observation.fault !== "string" ||
        observation.fault.trim() !== observation.fault ||
        observation.fault.length < 1 ||
        observation.fault.length > 120
      ) {
        throw new Error(`scenario ${scenario.id} has an invalid fault label`);
      }
      finiteNonNegative(observation.baseline.recoveryMs, "baseline.recoveryMs");
      finiteNonNegative(observation.controlled.recoveryMs, "controlled.recoveryMs");
      finiteNonNegative(observation.baseline.costUsd, "baseline.costUsd");
      finiteNonNegative(observation.controlled.costUsd, "controlled.costUsd");
    }
    const baselineRecoveryRate = mean(scenario.observations.map((item) => Number(item.baseline.recovered)));
    const controlledRecoveryRate = mean(scenario.observations.map((item) => Number(item.controlled.recovered)));
    const recoveryTimeImprovement = improvement(
      mean(scenario.observations.map((item) => item.baseline.recoveryMs)),
      mean(scenario.observations.map((item) => item.controlled.recoveryMs)),
    );
    const costImprovement = improvement(
      mean(scenario.observations.map((item) => item.baseline.costUsd)),
      mean(scenario.observations.map((item) => item.controlled.costUsd)),
    );
    const score =
      controlledRecoveryRate - baselineRecoveryRate + recoveryTimeImprovement * 0.5 + costImprovement * 0.25;
    return {
      id: scenario.id,
      samples: scenario.observations.length,
      baselineRecoveryRate,
      controlledRecoveryRate,
      recoveryTimeImprovement,
      costImprovement,
      verdict: score > 0.03 ? "improved" : score < -0.03 ? "regressed" : "neutral",
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    source: "simulation",
    scenarios: results,
    summary: {
      improved: results.filter((result) => result.verdict === "improved").length,
      neutral: results.filter((result) => result.verdict === "neutral").length,
      regressed: results.filter((result) => result.verdict === "regressed").length,
    },
  };
}

export function defaultControlPlaneScenarios(): ControlPlaneScenario[] {
  const observations = [
    [1, "provider-timeout", 180_000, 72_000, 0.18, 0.12],
    [2, "verifier-flake", 240_000, 95_000, 0.24, 0.15],
    [3, "cost-spike", 150_000, 68_000, 0.31, 0.17],
    [4, "stale-route", 300_000, 110_000, 0.27, 0.16],
  ] as const;
  return [
    {
      id: "longitudinal-control-plane",
      observations: observations.map(([day, fault, baselineMs, controlledMs, baselineCost, controlledCost]) => ({
        day,
        fault,
        baseline: { recovered: day !== 4, recoveryMs: baselineMs, costUsd: baselineCost },
        controlled: { recovered: true, recoveryMs: controlledMs, costUsd: controlledCost },
      })),
    },
  ];
}
import type { ControlPlaneEvalReport } from "@seekforge/shared";
