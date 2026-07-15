/** Paired, multi-sample A/B aggregation and rendering. */

import { costDistribution, proportionCi95, type ConfidenceInterval, type CostDistribution } from "./statistics.js";
import type { TaskResult } from "./task-runner.js";

const PASS = "PASS";
const FAIL = "FAIL";

function mark(success: boolean): string {
  return success ? PASS : FAIL;
}

function fmtCost(costUsd: number): string {
  return costUsd.toFixed(4);
}

function fmtOpt(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function costPerSuccess(successes: number, cost: number): string {
  return successes === 0 ? "n/a" : `${fmtCost(cost / successes)} USD`;
}

function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  if (Number.parseFloat(fixed) === 0) return (0).toFixed(digits);
  return fixed.startsWith("-") ? fixed : `+${fixed}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function interval(ci: ConfidenceInterval): string {
  return `${percent(ci.lower)}-${percent(ci.upper)}`;
}

export type VariantRun = { variant: string; results: TaskResult[] };
export type AbWinner = "a" | "b" | "tie";

export type AbTaskComparison = {
  taskId: string;
  sample?: number;
  a?: TaskResult;
  b?: TaskResult;
  /** Winner by success, score, turns, then cost. */
  winner: AbWinner;
};

export type AbVariantTotals = {
  successes: number;
  cost: number;
  count: number;
  successRate: number;
  successRateCi95: ConfidenceInterval;
  costDistribution: CostDistribution;
};

export type AbSummary = {
  variantA: string;
  variantB: string;
  tasks: AbTaskComparison[];
  aWins: number;
  bWins: number;
  ties: number;
  paired: {
    pairs: number;
    decisivePairs: number;
    aWinRate: number;
    aWinRateCi95: ConfidenceInterval;
  };
  totals: { a: AbVariantTotals; b: AbVariantTotals };
};

/** Deterministic order balancing for sequential provider calls. */
export function alternatingArmOrder(pairIndex: number): readonly ["a", "b"] | readonly ["b", "a"] {
  if (!Number.isSafeInteger(pairIndex) || pairIndex < 0) {
    throw new Error("pairIndex must be a non-negative safe integer");
  }
  return pairIndex % 2 === 0 ? ["a", "b"] : ["b", "a"];
}

/** A < B means a is better. */
function compareResults(a: TaskResult, b: TaskResult): number {
  if (a.success !== b.success) return a.success ? -1 : 1;
  const as = a.metrics.score;
  const bs = b.metrics.score;
  if (as !== undefined && bs !== undefined && as !== bs) return as > bs ? -1 : 1;
  const at = a.metrics.turns;
  const bt = b.metrics.turns;
  if (at !== undefined && bt !== undefined && at !== bt) return at < bt ? -1 : 1;
  if (a.metrics.costUsd !== b.metrics.costUsd) return a.metrics.costUsd < b.metrics.costUsd ? -1 : 1;
  return 0;
}

function pairKey(result: TaskResult): string {
  return `${result.taskId}\0${result.sample ?? 1}`;
}

function addArm(
  rows: Map<string, AbTaskComparison>,
  order: string[],
  result: TaskResult,
  arm: "a" | "b",
): void {
  const key = pairKey(result);
  let row = rows.get(key);
  if (!row) {
    row = {
      taskId: result.taskId,
      ...(result.sample !== undefined ? { sample: result.sample } : {}),
      winner: "tie",
    };
    rows.set(key, row);
    order.push(key);
  }
  if (row[arm] !== undefined) {
    throw new Error(`duplicate ${arm.toUpperCase()} result for paired sample ${result.taskId}#${result.sample ?? 1}`);
  }
  row[arm] = result;
}

function totals(results: TaskResult[]): AbVariantTotals {
  const successes = results.filter((result) => result.success).length;
  const count = results.length;
  const costs = results.map((result) => result.metrics.costUsd);
  return {
    successes,
    cost: costs.reduce((sum, cost) => sum + cost, 0),
    count,
    successRate: count === 0 ? 0 : successes / count,
    successRateCi95: proportionCi95(successes, count),
    costDistribution: costDistribution(costs),
  };
}

/** Pairs variants by the exact (task id, sample index) key. */
export function compareVariants(a: VariantRun, b: VariantRun): AbSummary {
  const rows = new Map<string, AbTaskComparison>();
  const order: string[] = [];
  for (const result of a.results) addArm(rows, order, result, "a");
  for (const result of b.results) addArm(rows, order, result, "b");

  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  for (const key of order) {
    const row = rows.get(key)!;
    if (row.a && row.b) {
      const compared = compareResults(row.a, row.b);
      row.winner = compared < 0 ? "a" : compared > 0 ? "b" : "tie";
    } else if (row.a) {
      row.winner = "a";
    } else if (row.b) {
      row.winner = "b";
    }
    if (row.winner === "a") aWins++;
    else if (row.winner === "b") bWins++;
    else ties++;
  }
  const pairedRows = order.map((key) => rows.get(key)!).filter((row) => row.a && row.b);
  const pairedAWins = pairedRows.filter((row) => row.winner === "a").length;
  const pairedBWins = pairedRows.filter((row) => row.winner === "b").length;
  const decisivePairs = pairedAWins + pairedBWins;
  return {
    variantA: a.variant,
    variantB: b.variant,
    tasks: order.map((key) => rows.get(key)!),
    aWins,
    bWins,
    ties,
    paired: {
      pairs: pairedRows.length,
      decisivePairs,
      aWinRate: decisivePairs === 0 ? 0.5 : pairedAWins / decisivePairs,
      aWinRateCi95: proportionCi95(pairedAWins, decisivePairs),
    },
    totals: { a: totals(a.results), b: totals(b.results) },
  };
}

function cell(result: TaskResult | undefined): string {
  if (!result) return "- | - | - | -";
  return `${mark(result.success)} | ${fmtOpt(result.metrics.score)} | ${fmtOpt(result.metrics.turns)} | ${fmtCost(result.metrics.costUsd)}`;
}

const WINNER_LABEL: Record<AbWinner, string> = { a: "A", b: "B", tie: "=" };

export function toAbMarkdown(summary: AbSummary): string {
  const { variantA, variantB } = summary;
  const lines: string[] = [
    `### A/B: ${variantA} (A) vs ${variantB} (B)`,
    "",
    "| Task/sample | A | A Score | A Turns | A Cost | B | B Score | B Turns | B Cost | Win |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of summary.tasks) {
    const label = row.sample === undefined ? row.taskId : `${row.taskId}#${row.sample}`;
    lines.push(`| ${label} | ${cell(row.a)} | ${cell(row.b)} | ${WINNER_LABEL[row.winner]} |`);
  }
  const { a, b } = summary.totals;
  lines.push(
    `| **Total** | ${a.successes}/${a.count} (${percent(a.successRate)}) | | | ${fmtCost(a.cost)} | ` +
      `${b.successes}/${b.count} (${percent(b.successRate)}) | | | ${fmtCost(b.cost)} | |`,
    "",
    `**Success rate (95% CI):** A ${percent(a.successRate)} [${interval(a.successRateCi95)}] | ` +
      `B ${percent(b.successRate)} [${interval(b.successRateCi95)}]`,
    `**Paired Win/Loss/Tie (A vs B):** ${summary.aWins} / ${summary.bWins} / ${summary.ties}; ` +
      `A win rate among ${summary.paired.decisivePairs} decisive pairs: ${percent(summary.paired.aWinRate)} ` +
      `[${interval(summary.paired.aWinRateCi95)}]`,
    `**Cost distribution:** A median ${fmtCost(a.costDistribution.median)}, p95 ${fmtCost(a.costDistribution.p95)}, ` +
      `mean ${fmtCost(a.costDistribution.mean)} [${fmtCost(a.costDistribution.meanCi95.lower)}-${fmtCost(a.costDistribution.meanCi95.upper)}]; ` +
      `B median ${fmtCost(b.costDistribution.median)}, p95 ${fmtCost(b.costDistribution.p95)}, ` +
      `mean ${fmtCost(b.costDistribution.mean)} [${fmtCost(b.costDistribution.meanCi95.lower)}-${fmtCost(b.costDistribution.meanCi95.upper)}]`,
    `**Cost delta (B-A):** ${signed(b.cost - a.cost, 4)}`,
    `**Cost per success:** A ${costPerSuccess(a.successes, a.cost)} | B ${costPerSuccess(b.successes, b.cost)}`,
  );
  return lines.join("\n");
}

export function toAbJson(runs: VariantRun[], summary: AbSummary): string {
  return `${JSON.stringify({ generatedAt: new Date().toISOString(), variants: runs, comparison: summary }, null, 2)}\n`;
}
