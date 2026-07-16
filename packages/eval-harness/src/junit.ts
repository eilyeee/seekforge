import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskResult } from "./task-runner.js";

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function toJunit(results: TaskResult[], name = "SeekForge Agent Eval"): string {
  const failures = results.filter((result) => !result.success && result.error === undefined).length;
  const errors = results.filter((result) => result.error !== undefined).length;
  const time = results.reduce((sum, result) => sum + result.metrics.durationMs, 0) / 1000;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xml(name)}" tests="${results.length}" failures="${failures}" errors="${errors}" time="${time.toFixed(3)}">`,
  ];
  for (const result of results) {
    const sample = result.sample === undefined ? "" : ` sample ${result.sample}`;
    lines.push(
      `  <testcase classname="seekforge.eval" name="${xml(result.taskId + sample)}" time="${(result.metrics.durationMs / 1000).toFixed(3)}">`,
    );
    if (result.error !== undefined) {
      lines.push(`    <error message="${xml(result.error)}">${xml(result.error)}</error>`);
    } else if (!result.success) {
      const detail =
        result.checks
          .filter((check) => !check.passed)
          .map((check) => check.detail ?? check.check.type)
          .join("\n") || "task did not pass";
      lines.push(`    <failure message="task failed">${xml(detail)}</failure>`);
    }
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>", "");
  return lines.join("\n");
}

export function writeJunit(results: TaskResult[], path: string, name?: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toJunit(results, name));
}
