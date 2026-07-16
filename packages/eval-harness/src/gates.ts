import { aggregateResults, type RunAggregate } from "./aggregate.js";
import { parseBaseline } from "./baseline.js";
import type { GateConfig } from "./suite-config.js";
import type { TaskResult } from "./task-runner.js";

export type GateCheck = {
  name: string;
  passed: boolean;
  actual: number | null;
  limit: number;
  message: string;
};

export type GateResult = { passed: boolean; checks: GateCheck[] };

function atMost(name: string, actual: number | null, limit: number, unit = ""): GateCheck {
  const passed = actual !== null && Number.isFinite(actual) && actual <= limit;
  return {
    name,
    passed,
    actual,
    limit,
    message:
      actual === null
        ? `${name}: unavailable (no successful samples)`
        : `${name}: ${actual.toFixed(4)}${unit} <= ${limit.toFixed(4)}${unit}`,
  };
}

function atLeast(name: string, actual: number, limit: number): GateCheck {
  return {
    name,
    passed: Number.isFinite(actual) && actual >= limit,
    actual,
    limit,
    message: `${name}: ${(actual * 100).toFixed(2)}% >= ${(limit * 100).toFixed(2)}%`,
  };
}

function increase(actual: number, baseline: number): number {
  if (baseline === 0) return actual === 0 ? 0 : Number.POSITIVE_INFINITY;
  return (actual - baseline) / baseline;
}

function baselineChecks(current: RunAggregate, baseline: RunAggregate, gates: GateConfig): GateCheck[] {
  const checks: GateCheck[] = [];
  checks.push(
    atMost("success-rate drop", Math.max(0, baseline.successRate - current.successRate), gates.maxSuccessRateDrop),
  );
  if (current.costPerSuccessUsd !== null && baseline.costPerSuccessUsd !== null) {
    checks.push(
      atMost(
        "cost-per-success increase",
        increase(current.costPerSuccessUsd, baseline.costPerSuccessUsd),
        gates.maxCostPerSuccessIncreaseRatio,
      ),
    );
  }
  // Legacy reports have no token fields. Skip the relative token check rather
  // than comparing a real run against an invented zero-token baseline.
  if (baseline.totalTokens > 0 && current.tokensPerSuccess !== null && baseline.tokensPerSuccess !== null) {
    checks.push(
      atMost(
        "tokens-per-success increase",
        increase(current.tokensPerSuccess, baseline.tokensPerSuccess),
        gates.maxTokensPerSuccessIncreaseRatio,
      ),
    );
  }
  checks.push(
    atMost(
      "tool-failure-rate increase",
      Math.max(0, current.toolFailureRate - baseline.toolFailureRate),
      gates.maxToolFailureRateIncrease,
    ),
  );
  return checks;
}

export function evaluateGates(results: TaskResult[], gates: GateConfig, baselineJson?: string): GateResult {
  const current = aggregateResults(results);
  const checks = [
    atLeast("success rate", current.successRate, gates.minSuccessRate),
    atMost("cost per success", current.costPerSuccessUsd, gates.maxCostPerSuccessUsd, " USD"),
    atMost("tokens per success", current.tokensPerSuccess, gates.maxTokensPerSuccess),
    atMost("tool failure rate", current.toolFailureRate, gates.maxToolFailureRate),
    atMost("session error rate", current.sessionErrorRate, gates.maxSessionErrorRate),
  ];
  if (baselineJson !== undefined) {
    const baseline = parseBaseline(baselineJson);
    const currentIds = new Set(results.map((result) => result.taskId));
    const baselineIds = new Set(baseline.map((result) => result.taskId));
    const commonIds = new Set([...currentIds].filter((id) => baselineIds.has(id)));
    if (commonIds.size > 0) {
      checks.push(
        ...baselineChecks(
          aggregateResults(results.filter((result) => commonIds.has(result.taskId))),
          aggregateResults(baseline.filter((result) => commonIds.has(result.taskId))),
          gates,
        ),
      );
    }
  }
  return { passed: checks.every((check) => check.passed), checks };
}
