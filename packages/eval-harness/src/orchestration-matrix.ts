import { compareByCodePoints } from "@seekforge/shared";

export type OrchestrationEvalEcosystem = "node" | "rust" | "python" | "go";
export type OrchestrationEvalExecution = "local" | "remote";
export type OrchestrationEvalFault = "none" | "retryable" | "crash_recovery" | "capacity_pressure" | "regression";

export type OrchestrationEvalObservation = {
  runId: string;
  ecosystem: OrchestrationEvalEcosystem;
  execution: OrchestrationEvalExecution;
  fault: OrchestrationEvalFault;
  passed: boolean;
  predictedP95Ms: number;
  predictedBreachProbability: number;
  actualDurationMs: number;
  breached: boolean;
  costUsd: number;
  datasetId?: string;
  environmentId?: string;
  providerId?: string;
  recordedAt?: string;
};

export type OrchestrationEvalCellKey = Pick<OrchestrationEvalObservation, "ecosystem" | "execution" | "fault">;

export type OrchestrationEvalCell = OrchestrationEvalCellKey & {
  samples: number;
  passRate: number;
  meanCostUsd: number;
  meanAbsoluteP95ErrorMs: number;
  p95Coverage: number;
  brierScore: number;
};

export type OrchestrationEvalMatrix = {
  schemaVersion: 1;
  generatedAt: string;
  samples: number;
  provenance: {
    datasets: string[];
    environments: string[];
    providers: string[];
  };
  cells: OrchestrationEvalCell[];
  missing: OrchestrationEvalCellKey[];
};

function key(value: OrchestrationEvalCellKey): string {
  return `${value.ecosystem}\0${value.execution}\0${value.fault}`;
}

function validateObservation(value: OrchestrationEvalObservation): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(value.runId)) throw new Error("invalid orchestration eval runId");
  if (
    !["node", "rust", "python", "go"].includes(value.ecosystem) ||
    !["local", "remote"].includes(value.execution) ||
    !["none", "retryable", "crash_recovery", "capacity_pressure", "regression"].includes(value.fault) ||
    typeof value.passed !== "boolean" ||
    typeof value.breached !== "boolean"
  ) {
    throw new Error("invalid orchestration eval classification");
  }
  for (const [name, metric] of [
    ["predictedP95Ms", value.predictedP95Ms],
    ["actualDurationMs", value.actualDurationMs],
    ["costUsd", value.costUsd],
  ] as const) {
    if (!Number.isFinite(metric) || metric < 0) throw new Error(`invalid orchestration eval ${name}`);
  }
  if (
    !Number.isFinite(value.predictedBreachProbability) ||
    value.predictedBreachProbability < 0 ||
    value.predictedBreachProbability > 1
  ) {
    throw new Error("invalid orchestration eval predictedBreachProbability");
  }
  for (const [name, id] of [
    ["datasetId", value.datasetId],
    ["environmentId", value.environmentId],
    ["providerId", value.providerId],
  ] as const) {
    if (id !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/.test(id)) {
      throw new Error(`invalid orchestration eval ${name}`);
    }
  }
  if (value.recordedAt !== undefined && !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new Error("invalid orchestration eval recordedAt");
  }
}

/** Aggregates real-project runs without averaging already-aggregated cells. */
export function buildOrchestrationEvaluationMatrix(
  observations: readonly OrchestrationEvalObservation[],
  required: readonly OrchestrationEvalCellKey[] = [],
  now = new Date(),
): OrchestrationEvalMatrix {
  if (observations.length > 10_000 || required.length > 1_000)
    throw new Error("orchestration eval matrix exceeds limit");
  if (!Number.isFinite(now.getTime())) throw new Error("invalid orchestration eval matrix time");
  const seen = new Set<string>();
  const groups = new Map<string, OrchestrationEvalObservation[]>();
  for (const observation of observations) {
    validateObservation(observation);
    if (seen.has(observation.runId)) throw new Error(`duplicate orchestration eval runId: ${observation.runId}`);
    seen.add(observation.runId);
    const id = key(observation);
    const group = groups.get(id) ?? [];
    group.push(observation);
    groups.set(id, group);
  }
  for (const requirement of required) {
    validateObservation({
      runId: "requirement",
      ...requirement,
      passed: false,
      predictedP95Ms: 0,
      predictedBreachProbability: 0,
      actualDurationMs: 0,
      breached: false,
      costUsd: 0,
    });
  }
  const cells = [...groups.values()]
    .map((group): OrchestrationEvalCell => {
      const first = group[0]!;
      const samples = group.length;
      return {
        ecosystem: first.ecosystem,
        execution: first.execution,
        fault: first.fault,
        samples,
        passRate: group.filter((item) => item.passed).length / samples,
        meanCostUsd: group.reduce((sum, item) => sum + item.costUsd, 0) / samples,
        meanAbsoluteP95ErrorMs:
          group.reduce((sum, item) => sum + Math.abs(item.actualDurationMs - item.predictedP95Ms), 0) / samples,
        p95Coverage: group.filter((item) => item.actualDurationMs <= item.predictedP95Ms).length / samples,
        brierScore:
          group.reduce((sum, item) => sum + (item.predictedBreachProbability - (item.breached ? 1 : 0)) ** 2, 0) /
          samples,
      };
    })
    .sort(
      (left, right) =>
        compareByCodePoints(left.ecosystem, right.ecosystem) ||
        compareByCodePoints(left.execution, right.execution) ||
        compareByCodePoints(left.fault, right.fault),
    );
  const missing = required.filter((requirement, index) => {
    const id = key(requirement);
    return !groups.has(id) && required.findIndex((candidate) => key(candidate) === id) === index;
  });
  const distinct = (values: Array<string | undefined>): string[] =>
    [...new Set(values.filter((value): value is string => value !== undefined))].sort();
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    samples: observations.length,
    provenance: {
      datasets: distinct(observations.map((item) => item.datasetId)),
      environments: distinct(observations.map((item) => item.environmentId)),
      providers: distinct(observations.map((item) => item.providerId)),
    },
    cells,
    missing,
  };
}

export type OrchestrationEvalDriftGate = {
  passed: boolean;
  minimumSamples: number;
  provenanceMismatch: boolean;
  violations: Array<OrchestrationEvalDrift & { reasons: string[] }>;
};

/** Applies a CI-ready regression gate to comparable matrix cells. */
export function evaluateOrchestrationEvaluationDrift(
  current: OrchestrationEvalMatrix,
  baseline: OrchestrationEvalMatrix,
  options: {
    minimumSamples?: number;
    maxPassRateDrop?: number;
    maxCostIncreaseUsd?: number;
    maxBrierIncrease?: number;
  } = {},
): OrchestrationEvalDriftGate {
  const minimumSamples = options.minimumSamples ?? 3;
  const maxPassRateDrop = options.maxPassRateDrop ?? 0.05;
  const maxCostIncreaseUsd = options.maxCostIncreaseUsd ?? 0.1;
  const maxBrierIncrease = options.maxBrierIncrease ?? 0.05;
  if (!Number.isSafeInteger(minimumSamples) || minimumSamples < 1 || minimumSamples > 10_000) {
    throw new RangeError("orchestration eval minimumSamples must be from 1 to 10000");
  }
  for (const [name, value] of [
    ["maxPassRateDrop", maxPassRateDrop],
    ["maxCostIncreaseUsd", maxCostIncreaseUsd],
    ["maxBrierIncrease", maxBrierIncrease],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`orchestration eval ${name} must be non-negative`);
  }
  const violations = compareOrchestrationEvaluationMatrices(current, baseline).flatMap((drift) => {
    if (drift.currentSamples < minimumSamples || drift.baselineSamples < minimumSamples) return [];
    const reasons = [
      ...(drift.passRateDelta < -maxPassRateDrop ? [`pass rate dropped by ${(-drift.passRateDelta).toFixed(4)}`] : []),
      ...(drift.meanCostUsdDelta > maxCostIncreaseUsd
        ? [`mean cost increased by ${drift.meanCostUsdDelta.toFixed(4)} USD`]
        : []),
      ...(drift.brierScoreDelta > maxBrierIncrease
        ? [`Brier score increased by ${drift.brierScoreDelta.toFixed(4)}`]
        : []),
    ];
    return reasons.length > 0 ? [{ ...drift, reasons }] : [];
  });
  const provenanceMismatch = JSON.stringify(current.provenance) !== JSON.stringify(baseline.provenance);
  return { passed: violations.length === 0 && !provenanceMismatch, minimumSamples, provenanceMismatch, violations };
}

export type OrchestrationEvalDrift = OrchestrationEvalCellKey & {
  currentSamples: number;
  baselineSamples: number;
  passRateDelta: number;
  meanCostUsdDelta: number;
  brierScoreDelta: number;
};

export function compareOrchestrationEvaluationMatrices(
  current: OrchestrationEvalMatrix,
  baseline: OrchestrationEvalMatrix,
): OrchestrationEvalDrift[] {
  const prior = new Map(baseline.cells.map((cell) => [key(cell), cell]));
  return current.cells.flatMap((cell) => {
    const before = prior.get(key(cell));
    return before
      ? [
          {
            ecosystem: cell.ecosystem,
            execution: cell.execution,
            fault: cell.fault,
            currentSamples: cell.samples,
            baselineSamples: before.samples,
            passRateDelta: cell.passRate - before.passRate,
            meanCostUsdDelta: cell.meanCostUsd - before.meanCostUsd,
            brierScoreDelta: cell.brierScore - before.brierScore,
          },
        ]
      : [];
  });
}
