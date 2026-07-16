import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { costDistribution, proportionCi95 } from "../src/statistics.js";
import { collectTrends, writeTrendReport } from "../src/trends.js";
import type { TaskResult } from "../src/task-runner.js";

function result(taskId: string, success: boolean, costUsd: number): TaskResult {
  return {
    taskId,
    success,
    checks: [],
    metrics: { toolCalls: 0, failedToolCalls: 0, costUsd, durationMs: 1 },
    skills: [],
  };
}

describe("statistics", () => {
  it("handles zero, one, and ordinary binomial samples without NaN", () => {
    expect(proportionCi95(0, 0)).toEqual({ lower: 0, upper: 1, confidence: 0.95 });
    expect(proportionCi95(1, 1)).toMatchObject({ upper: 1, confidence: 0.95 });
    const interval = proportionCi95(5, 10);
    expect(interval.lower).toBeLessThan(0.5);
    expect(interval.upper).toBeGreaterThan(0.5);
    expect(() => proportionCi95(2, 1)).toThrow();
  });

  it("computes interpolated cost quantiles and a finite mean interval", () => {
    expect(costDistribution([]).count).toBe(0);
    const distribution = costDistribution([0.01, 0.02, 0.03, 0.04]);
    expect(distribution).toMatchObject({ count: 4, min: 0.01, median: 0.025, max: 0.04, mean: 0.025 });
    expect(distribution.meanCi95.lower).toBeGreaterThanOrEqual(0);
    expect(distribution.meanCi95.upper).toBeGreaterThan(distribution.mean);
  });
});

describe("trend reports", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("collects standard and A/B JSON reports and writes durable markdown/json artifacts", () => {
    dir = mkdtempSync(join(tmpdir(), "seekforge-trends-"));
    writeFileSync(
      join(dir, "2026-01-01.json"),
      JSON.stringify({
        generatedAt: "2026-01-01T00:00:00.000Z",
        metadata: { variant: "control" },
        results: [result("a", true, 0.01), result("b", false, 0.03)],
      }),
    );
    writeFileSync(
      join(dir, "ab-2026-01-02.json"),
      JSON.stringify({
        generatedAt: "2026-01-02T00:00:00.000Z",
        variants: [
          { variant: "control", results: [result("a", true, 0.01)] },
          { variant: "candidate", results: [result("a", true, 0.02)] },
        ],
      }),
    );
    writeFileSync(join(dir, "broken.json"), "{not json");

    const entries = collectTrends(dir);
    expect(entries.map((item) => [item.kind, item.label])).toEqual([
      ["eval", "control"],
      ["ab", "candidate"],
      ["ab", "control"],
    ]);
    const written = writeTrendReport(dir);
    expect(existsSync(written.markdownPath)).toBe(true);
    expect(existsSync(written.jsonPath)).toBe(true);
    expect(readFileSync(written.markdownPath, "utf8")).toContain("Eval history trends");
    expect(JSON.parse(readFileSync(written.jsonPath, "utf8")).entries).toHaveLength(3);

    // CI restores the previous aggregate under a different filename. Its
    // entries merge with current reports without duplicating the overlap.
    writeFileSync(join(dir, "history-previous.json"), readFileSync(written.jsonPath, "utf8"));
    writeFileSync(
      join(dir, "2026-01-03.json"),
      JSON.stringify({
        generatedAt: "2026-01-03T00:00:00.000Z",
        metadata: { variant: "control" },
        results: [result("c", true, 0.04)],
      }),
    );
    expect(collectTrends(dir)).toHaveLength(4);
  });
});
