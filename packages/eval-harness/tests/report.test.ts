import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compare, regressions, summarize, toJson, toMarkdown, writeReport } from "../src/report.js";
import type { TaskResult } from "../src/task-runner.js";

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "title-change",
    success: true,
    checks: [
      { check: { type: "answer_matches", pattern: "x" }, passed: true },
      { check: { type: "command_succeeds", command: "npm test" }, passed: true },
    ],
    metrics: { turns: 3, toolCalls: 5, failedToolCalls: 0, costUsd: 0.01, durationMs: 1234, score: 100 },
    skills: [],
    ...overrides,
  };
}

const failing = (): TaskResult =>
  result({
    taskId: "failing-test-fix",
    success: false,
    checks: [
      { check: { type: "command_succeeds", command: "npm test" }, passed: false, detail: "exit 1" },
    ],
    metrics: { toolCalls: 2, failedToolCalls: 1, costUsd: 0.02, durationMs: 99, score: 60, turns: 12 },
  });

describe("toMarkdown", () => {
  it("renders one row per task plus a totals row", () => {
    const md = toMarkdown([result(), failing()]);
    const lines = md.split("\n");
    expect(lines[0]).toContain("| Task | Success | Checks | Score | Turns | Tool calls | Cost (USD) |");
    expect(md).toContain("| title-change | ✓ | 2/2 | 100 | 3 | 5 | 0.0100 |");
    expect(md).toContain("| failing-test-fix | ✗ | 0/1 | 60 | 12 | 2 | 0.0200 |");
    expect(md).toContain("| **Total** | 1/2 (50%) |");
    expect(md).toContain("0.0300");
  });

  it("renders '-' for missing score/turns", () => {
    const md = toMarkdown([
      result({ metrics: { toolCalls: 0, failedToolCalls: 0, costUsd: 0, durationMs: 1 } }),
    ]);
    expect(md).toContain("| title-change | ✓ | 2/2 | - | - | 0 | 0.0000 |");
  });

  it("renders headline success-rate and total-cost lines", () => {
    const md = toMarkdown([result(), failing()]);
    expect(md).toContain("Success rate: 1/2 (50%)");
    expect(md).toContain("Total cost: 0.0300 USD");
  });

  it("renders cost-per-success as total cost over successes", () => {
    // 1 success, total cost 0.0300 → 0.0300 per success.
    const md = toMarkdown([result(), failing()]);
    expect(md).toContain("Cost per success: 0.0300 USD");
  });

  it("renders cost-per-success as 'n/a' when nothing passed", () => {
    const md = toMarkdown([failing(), failing()]);
    expect(md).toContain("Cost per success: n/a");
  });
});

describe("summarize", () => {
  it("computes passed, total, rate and total cost", () => {
    expect(summarize([result(), failing()])).toEqual({
      passed: 1,
      total: 2,
      rate: 50,
      totalCostUsd: 0.03,
    });
  });

  it("rounds the rate to a whole percent", () => {
    const summary = summarize([result(), result(), failing()]); // 2/3
    expect(summary.passed).toBe(2);
    expect(summary.total).toBe(3);
    expect(summary.rate).toBe(67); // 66.66… rounds to 67
  });

  it("returns rate 0 (not NaN) for an empty run", () => {
    expect(summarize([])).toEqual({ passed: 0, total: 0, rate: 0, totalCostUsd: 0 });
  });
});

describe("toJson / compare", () => {
  it("toJson round-trips the results", () => {
    const results = [result(), failing()];
    const parsed = JSON.parse(toJson(results)) as { generatedAt: string; results: TaskResult[] };
    expect(parsed.results).toEqual(results);
    expect(parsed.generatedAt).toMatch(/^\d{4}-/);
  });

  it("compare reports success, score and cost deltas per task", () => {
    const baseline = toJson([
      result({ success: false, metrics: { toolCalls: 5, failedToolCalls: 2, costUsd: 0.03, durationMs: 1, score: 80, turns: 4 } }),
      failing(),
    ]);
    const current = [
      result(), // success ✗→✓, score 80→100, cost 0.03→0.01
      result({ taskId: "brand-new" }),
    ];
    const md = compare(current, baseline);
    expect(md).toContain("| title-change | ✗ → ✓ | +20 | -0.0200 |");
    expect(md).toContain("| brand-new | new ✓ | - | - |");
  });
});

describe("writeReport", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes timestamped .md and .json files and returns their paths", () => {
    dir = mkdtempSync(join(tmpdir(), "seekforge-eval-reports-"));
    const { markdownPath, jsonPath } = writeReport([result()], dir);
    expect(existsSync(markdownPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);
    expect(markdownPath.endsWith(".md")).toBe(true);
    expect(jsonPath.endsWith(".json")).toBe(true);
    expect(readFileSync(markdownPath, "utf8")).toContain("| title-change |");
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as { results: TaskResult[] };
    expect(parsed.results[0]?.taskId).toBe("title-change");
  });
});

describe("regressions", () => {
  const baseline = toJson([
    result({ taskId: "a", success: true }),
    result({ taskId: "b", success: false }),
    result({ taskId: "c", success: true }),
  ]);

  it("flags only pass→fail tasks", () => {
    const current = [
      result({ taskId: "a", success: false }), // regressed
      result({ taskId: "b", success: false }), // already red — not a regression
      result({ taskId: "c", success: true }), // still green
    ];
    expect(regressions(current, baseline)).toEqual(["a"]);
  });

  it("ignores newly-added tasks and fixed tasks", () => {
    const current = [
      result({ taskId: "b", success: true }), // fixed (fail→pass)
      result({ taskId: "d", success: false }), // new, not in baseline
    ];
    expect(regressions(current, baseline)).toEqual([]);
  });

  it("returns [] when nothing regressed", () => {
    expect(regressions([result({ taskId: "a", success: true })], baseline)).toEqual([]);
  });
});
