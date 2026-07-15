/**
 * Eval reports: markdown table, JSON serialization, baseline comparison for
 * regression tracking, and timestamped report files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportsDir as defaultReportsDir } from "./paths.js";
import { aggregateResults, type RunAggregate } from "./aggregate.js";
import { parseBaseline } from "./baseline.js";
import type { GateResult } from "./gates.js";
import type { RunMetadata } from "./run-metadata.js";
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

/**
 * Total cost divided by number of successes, guarding divide-by-zero: "n/a"
 * when nothing passed (so the metric never invents a cost for zero wins).
 */
function costPerSuccess(passed: number, totalCostUsd: number): string {
  return passed === 0 ? "n/a" : `${fmtCost(totalCostUsd / passed)} USD`;
}

export type Summary = {
  /** Tasks whose session completed and every check passed. */
  passed: number;
  /** Total tasks in the run. */
  total: number;
  /** passed / total as a whole-number percentage (0 when total is 0). */
  rate: number;
  /** Sum of metrics.costUsd across all results. */
  totalCostUsd: number;
};

/** Headline run numbers that drive agent-quality work. Pure; no I/O. */
export function summarize(results: TaskResult[]): Summary {
  const passed = results.filter((r) => r.success).length;
  const total = results.length;
  const rate = total === 0 ? 0 : Math.round((passed / total) * 100);
  const totalCostUsd = results.reduce((sum, r) => sum + r.metrics.costUsd, 0);
  return { passed, total, rate, totalCostUsd };
}

export function toMarkdown(results: TaskResult[]): string {
  const lines: string[] = [
    "| Task | Success | Checks | Score | Turns | Tool calls | Cost (USD) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of results) {
    const passed = r.checks.filter((c) => c.passed).length;
    const taskLabel = r.sample === undefined ? r.taskId : `${r.taskId}#${r.sample}`;
    lines.push(
      `| ${taskLabel} | ${mark(r.success)} | ${passed}/${r.checks.length} | ${fmtOpt(r.metrics.score)} | ` +
        `${fmtOpt(r.metrics.turns)} | ${r.metrics.toolCalls} | ${fmtCost(r.metrics.costUsd)} |`,
    );
  }
  const { passed, total, rate, totalCostUsd } = summarize(results);
  lines.push(`| **Total** | ${passed}/${total} (${rate}%) | | | | | ${fmtCost(totalCostUsd)} |`);
  lines.push("");
  lines.push(`Success rate: ${passed}/${total} (${rate}%)`);
  lines.push(`Total cost: ${fmtCost(totalCostUsd)} USD`);
  lines.push(`Cost per success: ${costPerSuccess(passed, totalCostUsd)}`);
  const aggregate = aggregateResults(results);
  lines.push(`Tokens: ${aggregate.totalTokens} total, ${aggregate.tokensPerSuccess?.toFixed(0) ?? "n/a"} per success`);
  lines.push(`Tool failure rate: ${(aggregate.toolFailureRate * 100).toFixed(2)}%`);
  lines.push(`Session error rate: ${(aggregate.sessionErrorRate * 100).toFixed(2)}%`);
  lines.push(`Duration: ${(aggregate.durationMs / 1000).toFixed(1)}s`);
  return lines.join("\n");
}

export type ReportOptions = { metadata?: RunMetadata; aggregate?: RunAggregate; gates?: GateResult };

export function toJson(results: TaskResult[], options: ReportOptions = {}): string {
  return `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    ...(options.metadata ? { metadata: options.metadata } : {}),
    results,
    ...(options.aggregate ? { aggregate: options.aggregate } : {}),
    ...(options.gates ? { gates: options.gates } : {}),
  }, null, 2)}\n`;
}

function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  // Decide the sign AFTER rounding so a value that rounds to zero renders an
  // unsigned "0" rather than a misleading "+0" / "-0.0000".
  if (Number.parseFloat(fixed) === 0) return (0).toFixed(digits);
  return fixed.startsWith("-") ? fixed : `+${fixed}`;
}

/** Per-task delta table (current vs a previous toJson report) for regression tracking. */
export function compare(current: TaskResult[], baselineJson: string): string {
  const baseline = new Map(parseBaseline(baselineJson).map((r) => [r.taskId, r]));
  const lines: string[] = [
    "| Task | Success | Score Δ | Cost Δ (USD) |",
    "| --- | --- | --- | --- |",
  ];
  for (const r of current) {
    const base = baseline.get(r.taskId);
    if (!base) {
      lines.push(`| ${r.taskId} | new ${mark(r.success)} | - | - |`);
      continue;
    }
    const success = `${mark(base.success)} → ${mark(r.success)}`;
    const scoreDelta =
      base.metrics.score !== undefined && r.metrics.score !== undefined
        ? signed(r.metrics.score - base.metrics.score, 0)
        : "-";
    const costDelta = signed(r.metrics.costUsd - base.metrics.costUsd, 4);
    lines.push(`| ${r.taskId} | ${success} | ${scoreDelta} | ${costDelta} |`);
  }
  return lines.join("\n");
}

/**
 * Task ids that regressed against the baseline: a task the baseline recorded as
 * a success that is now a failure. Tasks newly added, removed, or already
 * failing in the baseline are NOT regressions — so a known-red/flaky case never
 * trips the gate; only a genuine pass→fail does. Used by `--fail-on-regression`.
 */
export function regressions(current: TaskResult[], baselineJson: string): string[] {
  const passByTask = (results: TaskResult[]): Map<string, boolean> => {
    const counts = new Map<string, { passed: number; total: number }>();
    for (const result of results) {
      const count = counts.get(result.taskId) ?? { passed: 0, total: 0 };
      count.total++;
      if (result.success) count.passed++;
      counts.set(result.taskId, count);
    }
    return new Map([...counts].map(([taskId, count]) => [taskId, count.passed / count.total > 0.5]));
  };
  const baseline = passByTask(parseBaseline(baselineJson));
  const currentByTask = passByTask(current);
  return [...currentByTask]
    .filter(([taskId, passed]) => baseline.get(taskId) === true && !passed)
    .map(([taskId]) => taskId);
}

export type WrittenReport = { markdownPath: string; jsonPath: string };

/** Writes <ISO-timestamp>.md and .json under dir; returns both paths. */
export function writeReport(
  results: TaskResult[],
  dir: string = defaultReportsDir,
  options: ReportOptions = {},
): WrittenReport {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const markdownPath = join(dir, `${stamp}.md`);
  const jsonPath = join(dir, `${stamp}.json`);
  const metadata = options.metadata
    ? `\n\n## Run metadata\n\n${Object.entries(options.metadata).map(([key, value]) => `- ${key}: ${value}`).join("\n")}`
    : "";
  const gates = options.gates
    ? `\n\n## Gates\n\n${options.gates.checks.map((gate) => `- ${gate.passed ? "PASS" : "FAIL"}: ${gate.message}`).join("\n")}`
    : "";
  writeFileSync(markdownPath, `# SeekForge eval report\n\n${toMarkdown(results)}${metadata}${gates}\n`);
  writeFileSync(jsonPath, toJson(results, options));
  return { markdownPath, jsonPath };
}
