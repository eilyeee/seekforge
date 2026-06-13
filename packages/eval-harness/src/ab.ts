/**
 * Prompt/config A/B: run the full task set under two named variants and
 * compare them per task (success / score / turns / cost) plus win-loss-tie
 * totals. Aggregation and rendering here are pure; the actual running lives in
 * cli.ts so this stays testable without an agent.
 */

import type { TaskResult } from "./task-runner.js";

const PASS = "✓";
const FAIL = "✗";

function mark(success: boolean): string {
  return success ? PASS : FAIL;
}

function fmtCost(costUsd: number): string {
  return costUsd.toFixed(4);
}

function fmtOpt(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
}

/** One variant's results plus the variant name they were produced under. */
export type VariantRun = {
  variant: string;
  results: TaskResult[];
};

export type AbWinner = "a" | "b" | "tie";

export type AbTaskComparison = {
  taskId: string;
  a?: TaskResult;
  b?: TaskResult;
  /**
   * Winner by success first, then score (higher), then turns (fewer), then
   * cost (cheaper). "tie" when both miss on every axis OR are equal throughout.
   */
  winner: AbWinner;
};

export type AbSummary = {
  variantA: string;
  variantB: string;
  tasks: AbTaskComparison[];
  /** Counts where A beats B / B beats A / neither (tie or missing pair). */
  aWins: number;
  bWins: number;
  ties: number;
  totals: {
    a: { successes: number; cost: number; count: number };
    b: { successes: number; cost: number; count: number };
  };
};

/** A < B means a is better; returns -1 (a better), 1 (b better), 0 (equal). */
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

/** Pairs two variant runs by task id and decides a winner per task. */
export function compareVariants(a: VariantRun, b: VariantRun): AbSummary {
  const byId = new Map<string, AbTaskComparison>();
  const order: string[] = [];
  const ensure = (taskId: string): AbTaskComparison => {
    let row = byId.get(taskId);
    if (!row) {
      row = { taskId, winner: "tie" };
      byId.set(taskId, row);
      order.push(taskId);
    }
    return row;
  };
  for (const r of a.results) ensure(r.taskId).a = r;
  for (const r of b.results) ensure(r.taskId).b = r;

  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  for (const taskId of order) {
    const row = byId.get(taskId)!;
    let winner: AbWinner = "tie";
    if (row.a && row.b) {
      const cmp = compareResults(row.a, row.b);
      winner = cmp < 0 ? "a" : cmp > 0 ? "b" : "tie";
    } else if (row.a) {
      winner = "a"; // only A ran/has this task
    } else if (row.b) {
      winner = "b";
    }
    row.winner = winner;
    if (winner === "a") aWins++;
    else if (winner === "b") bWins++;
    else ties++;
  }

  const total = (results: TaskResult[]) => ({
    successes: results.filter((r) => r.success).length,
    cost: results.reduce((sum, r) => sum + r.metrics.costUsd, 0),
    count: results.length,
  });

  return {
    variantA: a.variant,
    variantB: b.variant,
    tasks: order.map((id) => byId.get(id)!),
    aWins,
    bWins,
    ties,
    totals: { a: total(a.results), b: total(b.results) },
  };
}

function cell(r: TaskResult | undefined): string {
  if (!r) return "- | - | - | -";
  return `${mark(r.success)} | ${fmtOpt(r.metrics.score)} | ${fmtOpt(r.metrics.turns)} | ${fmtCost(r.metrics.costUsd)}`;
}

const WINNER_LABEL: Record<AbWinner, string> = { a: "A", b: "B", tie: "=" };

/** Renders the A/B comparison as a markdown table with a win/loss/tie footer. */
export function toAbMarkdown(summary: AbSummary): string {
  const { variantA, variantB } = summary;
  const lines: string[] = [
    `### A/B: ${variantA} (A) vs ${variantB} (B)`,
    "",
    "| Task | A ✓ | A Score | A Turns | A Cost | B ✓ | B Score | B Turns | B Cost | Win |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of summary.tasks) {
    lines.push(`| ${row.taskId} | ${cell(row.a)} | ${cell(row.b)} | ${WINNER_LABEL[row.winner]} |`);
  }
  const { a, b } = summary.totals;
  const rateA = a.count === 0 ? 0 : Math.round((a.successes / a.count) * 100);
  const rateB = b.count === 0 ? 0 : Math.round((b.successes / b.count) * 100);
  lines.push(
    `| **Total** | ${a.successes}/${a.count} (${rateA}%) | | | ${fmtCost(a.cost)} | ` +
      `${b.successes}/${b.count} (${rateB}%) | | | ${fmtCost(b.cost)} | |`,
  );
  lines.push("");
  lines.push(
    `**Win/Loss/Tie (A vs B):** ${summary.aWins} / ${summary.bWins} / ${summary.ties} ` +
      `· cost Δ (B−A): ${signed(b.cost - a.cost, 4)}`,
  );
  return lines.join("\n");
}

/** Machine-readable A/B payload for evals/reports/ab-<ts>.json. */
export function toAbJson(runs: VariantRun[], summary: AbSummary): string {
  return `${JSON.stringify(
    { generatedAt: new Date().toISOString(), variants: runs, comparison: summary },
    null,
    2,
  )}\n`;
}
