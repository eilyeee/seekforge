import { currentLoopBudgetReason, forecastLoopBudgetReason, forecastLoopBudgetUsage } from "./loop-budget-policy.js";
import type { LoopState } from "./loop-state.js";
import {
  analyzeLoopVerificationIntelligence,
  summarizeLoopVerificationReliability,
  type LoopVerificationIntelligence,
  type LoopVerificationReliability,
} from "./loop-verification-intelligence.js";

export type LoopHealthFinding = {
  kind: "terminal_failure" | "budget_risk" | "iteration_risk" | "recovery_backoff" | "verification_instability";
  severity: "warning" | "critical";
  message: string;
  stageId?: string;
};

type LoopCapacityKind = "cost" | "tokens" | "duration" | "verify_runs" | "iterations";

export type LoopHealthReport = {
  loopId: string;
  generatedAt: string;
  status: "unknown" | "healthy" | "warning" | "critical";
  progress: { iterations: number; maxIterations: number; remainingIterations: number; completionRatio: number };
  usage: {
    costUsd: number;
    costBudgetUsd?: number;
    remainingCostUsd?: number;
    tokensUsed: number;
    tokenBudget?: number;
    remainingTokens?: number;
    elapsedMs: number;
    maxDurationMs?: number;
    remainingDurationMs?: number;
    verifyRuns: number;
    maxVerifyRuns?: number;
    remainingVerifyRuns?: number;
  };
  forecast: {
    samples: number;
    nextIterationCostUsd: number;
    nextIterationTokens: number;
    nextIterationDurationMs: number;
    nextIterationVerifyRuns: number;
    affordableIterations: number;
    limitingBudget?: LoopCapacityKind;
  };
  verification: LoopVerificationReliability[];
  findings: LoopHealthFinding[];
};

const TERMINAL_FAILURES = new Set<LoopState["status"]>([
  "exhausted",
  "no_progress",
  "budget",
  "verify_error",
  "agent_error",
]);

function boundedCapacity(remaining: number | undefined, forecast: number): number | undefined {
  if (remaining === undefined) return undefined;
  if (remaining <= 0) return 0;
  if (forecast <= 0) return undefined;
  // Hard budgets reject equality, so only iterations that stay strictly below
  // the remaining capacity are affordable.
  return Math.max(0, Math.ceil(remaining / forecast) - 1);
}

/** Builds output-free Loop health from one checkpoint and matching retained intelligence. */
export function buildLoopHealthReport(
  state: LoopState,
  intelligence: readonly LoopVerificationIntelligence[],
  now = new Date(),
): LoopHealthReport {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Loop health time is invalid");
  const stages = state.verificationPlan ?? [{ id: "verify", command: state.verifyCommand }];
  const matching = stages.flatMap((stage) => {
    const entry = intelligence.find(
      (candidate) => candidate.stageId === stage.id && candidate.command === stage.command,
    );
    return entry ? [entry] : [];
  });
  const verification = matching.map((entry) => summarizeLoopVerificationReliability(entry, nowMs));
  const findings: LoopHealthFinding[] = [];
  if (TERMINAL_FAILURES.has(state.status)) {
    findings.push({ kind: "terminal_failure", severity: "critical", message: `Loop settled as ${state.status}` });
  }
  const remainingIterations = Math.max(0, state.maxIterations - state.iterations);
  if (state.status !== "passed" && remainingIterations === 0) {
    findings.push({ kind: "iteration_risk", severity: "critical", message: "No edit iterations remain" });
  } else if (state.status !== "passed" && remainingIterations === 1) {
    findings.push({ kind: "iteration_risk", severity: "warning", message: "Only one edit iteration remains" });
  }
  const limits = {
    ...(state.costBudgetUsd === null ? {} : { costBudgetUsd: state.costBudgetUsd }),
    ...(state.tokenBudget == null ? {} : { tokenBudget: state.tokenBudget }),
    ...(state.maxDurationMs == null ? {} : { maxDurationMs: state.maxDurationMs }),
    ...(state.maxVerifyRuns == null ? {} : { maxVerifyRuns: state.maxVerifyRuns }),
  };
  const usage = {
    costUsd: state.costUsd,
    tokensUsed: state.tokensUsed ?? 0,
    elapsedMs: state.elapsedMs ?? 0,
    verifyRuns: state.verifyRuns ?? 0,
  };
  const forecastUsage = forecastLoopBudgetUsage(state.snapshots ?? []);
  const exhaustedBudget = currentLoopBudgetReason(usage, limits);
  if (exhaustedBudget && state.status !== "budget") {
    findings.push({
      kind: "budget_risk",
      severity: "critical",
      message: `The ${exhaustedBudget} budget is exhausted`,
    });
  }
  const budgetRisk = forecastLoopBudgetReason(usage, limits, state.snapshots ?? []);
  if (!exhaustedBudget && budgetRisk && state.status !== "budget") {
    findings.push({
      kind: "budget_risk",
      severity: "warning",
      message: `The next conservative iteration may exhaust the ${budgetRisk} budget`,
    });
  }
  if (state.recovery?.nextAttemptAt && Date.parse(state.recovery.nextAttemptAt) > nowMs) {
    findings.push({
      kind: "recovery_backoff",
      severity: state.recovery.attempts >= 3 ? "critical" : "warning",
      message: `Automatic recovery is backed off until ${state.recovery.nextAttemptAt}`,
    });
  }
  for (const finding of analyzeLoopVerificationIntelligence(matching)) {
    findings.push({
      kind: "verification_instability",
      severity: finding.severity,
      message: finding.message,
      stageId: finding.stageId,
    });
  }
  const remainingCostUsd =
    limits.costBudgetUsd === undefined
      ? undefined
      : Math.max(0, Number((limits.costBudgetUsd - usage.costUsd).toFixed(12)));
  const remainingTokens =
    limits.tokenBudget === undefined ? undefined : Math.max(0, limits.tokenBudget - usage.tokensUsed);
  const remainingDurationMs =
    limits.maxDurationMs === undefined ? undefined : Math.max(0, limits.maxDurationMs - usage.elapsedMs);
  const remainingVerifyRuns =
    limits.maxVerifyRuns === undefined ? undefined : Math.max(0, limits.maxVerifyRuns - usage.verifyRuns);
  const capacities: Array<{ kind: LoopCapacityKind; value: number }> = [
    { kind: "iterations", value: remainingIterations },
  ];
  const addCapacity = (kind: LoopCapacityKind, remaining: number | undefined, forecast: number): void => {
    const value = boundedCapacity(remaining, forecast);
    if (value !== undefined) capacities.push({ kind, value });
  };
  addCapacity("cost", remainingCostUsd, forecastUsage.costUsd);
  addCapacity("tokens", remainingTokens, forecastUsage.tokensUsed);
  addCapacity("duration", remainingDurationMs, forecastUsage.durationMs);
  addCapacity("verify_runs", remainingVerifyRuns, forecastUsage.verifyRuns);
  capacities.sort((left, right) => left.value - right.value);
  const limiting = capacities[0];
  const status = findings.some((finding) => finding.severity === "critical")
    ? "critical"
    : findings.length > 0
      ? "warning"
      : state.iterations === 0 && matching.length === 0
        ? "unknown"
        : "healthy";
  return {
    loopId: state.loopId,
    generatedAt: now.toISOString(),
    status,
    progress: {
      iterations: state.iterations,
      maxIterations: state.maxIterations,
      remainingIterations,
      completionRatio: state.maxIterations === 0 ? 0 : state.iterations / state.maxIterations,
    },
    usage: {
      ...usage,
      ...(limits.costBudgetUsd === undefined
        ? {}
        : { costBudgetUsd: limits.costBudgetUsd, remainingCostUsd: remainingCostUsd! }),
      ...(limits.tokenBudget === undefined
        ? {}
        : { tokenBudget: limits.tokenBudget, remainingTokens: remainingTokens! }),
      ...(limits.maxDurationMs === undefined
        ? {}
        : { maxDurationMs: limits.maxDurationMs, remainingDurationMs: remainingDurationMs! }),
      ...(limits.maxVerifyRuns === undefined
        ? {}
        : { maxVerifyRuns: limits.maxVerifyRuns, remainingVerifyRuns: remainingVerifyRuns! }),
    },
    forecast: {
      samples: forecastUsage.samples,
      nextIterationCostUsd: forecastUsage.costUsd,
      nextIterationTokens: forecastUsage.tokensUsed,
      nextIterationDurationMs: forecastUsage.durationMs,
      nextIterationVerifyRuns: forecastUsage.verifyRuns,
      affordableIterations: limiting?.value ?? remainingIterations,
      ...(limiting ? { limitingBudget: limiting.kind } : {}),
    },
    verification,
    findings,
  };
}
