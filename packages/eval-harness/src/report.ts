/**
 * Eval reports: markdown table, JSON serialization, baseline comparison for
 * regression tracking, and timestamped report files.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reportsDir as defaultReportsDir } from "./paths.js";
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
    lines.push(
      `| ${r.taskId} | ${mark(r.success)} | ${passed}/${r.checks.length} | ${fmtOpt(r.metrics.score)} | ` +
        `${fmtOpt(r.metrics.turns)} | ${r.metrics.toolCalls} | ${fmtCost(r.metrics.costUsd)} |`,
    );
  }
  const { passed, total, rate, totalCostUsd } = summarize(results);
  lines.push(`| **Total** | ${passed}/${total} (${rate}%) | | | | | ${fmtCost(totalCostUsd)} |`);
  lines.push("");
  lines.push(`Success rate: ${passed}/${total} (${rate}%)`);
  lines.push(`Total cost: ${fmtCost(totalCostUsd)} USD`);
  return lines.join("\n");
}

export function toJson(results: TaskResult[]): string {
  return `${JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2)}\n`;
}

function parseBaseline(baselineJson: string): TaskResult[] {
  const parsed: unknown = JSON.parse(baselineJson);
  if (Array.isArray(parsed)) return parsed as TaskResult[];
  if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { results?: unknown }).results)) {
    return (parsed as { results: TaskResult[] }).results;
  }
  throw new Error("baseline JSON must be a report file ({results: [...]}) or an array of task results");
}

function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return value >= 0 ? `+${fixed}` : fixed;
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
  const base = new Map(parseBaseline(baselineJson).map((r) => [r.taskId, r]));
  return current.filter((r) => base.get(r.taskId)?.success && !r.success).map((r) => r.taskId);
}

export type WrittenReport = { markdownPath: string; jsonPath: string };

/** Writes <ISO-timestamp>.md and .json under dir; returns both paths. */
export function writeReport(results: TaskResult[], dir: string = defaultReportsDir): WrittenReport {
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const markdownPath = join(dir, `${stamp}.md`);
  const jsonPath = join(dir, `${stamp}.json`);
  writeFileSync(markdownPath, `# SeekForge eval report\n\n${toMarkdown(results)}\n`);
  writeFileSync(jsonPath, toJson(results));
  return { markdownPath, jsonPath };
}
