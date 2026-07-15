import { describe, expect, it } from "vitest";
import { alternatingArmOrder, compareVariants, toAbJson, toAbMarkdown, type VariantRun } from "../src/ab.js";
import type { TaskResult } from "../src/task-runner.js";

function res(overrides: Partial<TaskResult> & { taskId: string }): TaskResult {
  return {
    success: true,
    checks: [],
    metrics: { turns: 5, toolCalls: 3, failedToolCalls: 0, costUsd: 0.01, durationMs: 1, score: 90 },
    skills: [],
    ...overrides,
  };
}

function run(variant: string, results: TaskResult[]): VariantRun {
  return { variant, results };
}

describe("compareVariants", () => {
  it("success beats failure regardless of score/turns/cost", () => {
    const a = run("control", [res({ taskId: "t1", success: true, metrics: { turns: 99, toolCalls: 0, failedToolCalls: 0, costUsd: 9, durationMs: 1, score: 0 } })]);
    const b = run("terse", [res({ taskId: "t1", success: false, metrics: { turns: 1, toolCalls: 0, failedToolCalls: 0, costUsd: 0, durationMs: 1, score: 100 } })]);
    const summary = compareVariants(a, b);
    expect(summary.tasks[0]?.winner).toBe("a");
    expect(summary.aWins).toBe(1);
    expect(summary.bWins).toBe(0);
    expect(summary.ties).toBe(0);
  });

  it("on equal success, higher score wins; then fewer turns; then cheaper", () => {
    // higher score
    expect(
      compareVariants(
        run("a", [res({ taskId: "t", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 1, durationMs: 1, score: 80 } })]),
        run("b", [res({ taskId: "t", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 1, durationMs: 1, score: 95 } })]),
      ).tasks[0]?.winner,
    ).toBe("b");
    // equal score -> fewer turns
    expect(
      compareVariants(
        run("a", [res({ taskId: "t", metrics: { turns: 3, toolCalls: 0, failedToolCalls: 0, costUsd: 1, durationMs: 1, score: 90 } })]),
        run("b", [res({ taskId: "t", metrics: { turns: 7, toolCalls: 0, failedToolCalls: 0, costUsd: 1, durationMs: 1, score: 90 } })]),
      ).tasks[0]?.winner,
    ).toBe("a");
    // equal score+turns -> cheaper
    expect(
      compareVariants(
        run("a", [res({ taskId: "t", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 0.05, durationMs: 1, score: 90 } })]),
        run("b", [res({ taskId: "t", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 0.02, durationMs: 1, score: 90 } })]),
      ).tasks[0]?.winner,
    ).toBe("b");
  });

  it("identical results are a tie", () => {
    const a = run("a", [res({ taskId: "t" })]);
    const b = run("b", [res({ taskId: "t" })]);
    const summary = compareVariants(a, b);
    expect(summary.tasks[0]?.winner).toBe("tie");
    expect(summary.ties).toBe(1);
  });

  it("aggregates win/loss/tie across multiple tasks and totals cost", () => {
    const a = run("control", [
      res({ taskId: "t1", success: true, metrics: { turns: 4, toolCalls: 0, failedToolCalls: 0, costUsd: 0.02, durationMs: 1, score: 90 } }),
      res({ taskId: "t2", success: false, metrics: { turns: 8, toolCalls: 0, failedToolCalls: 0, costUsd: 0.03, durationMs: 1, score: 50 } }),
      res({ taskId: "t3", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 0.01, durationMs: 1, score: 70 } }),
    ]);
    const b = run("terse", [
      res({ taskId: "t1", success: true, metrics: { turns: 6, toolCalls: 0, failedToolCalls: 0, costUsd: 0.02, durationMs: 1, score: 90 } }), // a fewer turns -> a
      res({ taskId: "t2", success: true, metrics: { turns: 8, toolCalls: 0, failedToolCalls: 0, costUsd: 0.03, durationMs: 1, score: 50 } }), // b success -> b
      res({ taskId: "t3", metrics: { turns: 5, toolCalls: 0, failedToolCalls: 0, costUsd: 0.01, durationMs: 1, score: 70 } }), // tie
    ]);
    const summary = compareVariants(a, b);
    expect(summary.aWins).toBe(1);
    expect(summary.bWins).toBe(1);
    expect(summary.ties).toBe(1);
    expect(summary.totals.a.successes).toBe(2);
    expect(summary.totals.b.successes).toBe(3);
    expect(summary.totals.a.cost).toBeCloseTo(0.06);
    expect(summary.totals.b.cost).toBeCloseTo(0.06);
  });

  it("a task present in only one variant is credited to that variant", () => {
    const a = run("a", [res({ taskId: "only-a" })]);
    const b = run("b", [res({ taskId: "only-b" })]);
    const summary = compareVariants(a, b);
    expect(summary.tasks.map((t) => t.taskId)).toEqual(["only-a", "only-b"]);
    expect(summary.aWins).toBe(1);
    expect(summary.bWins).toBe(1);
  });

  it("renders a markdown table and a win/loss/tie footer", () => {
    const summary = compareVariants(
      run("control", [res({ taskId: "t1" })]),
      run("terse", [res({ taskId: "t1", success: false })]),
    );
    const md = toAbMarkdown(summary);
    expect(md).toContain("A/B: control (A) vs terse (B)");
    expect(md).toContain("| t1 |");
    expect(md).toContain("Win/Loss/Tie (A vs B):** 1 / 0 / 0");
  });

  it("toAbJson embeds both runs and the comparison", () => {
    const a = run("control", [res({ taskId: "t1" })]);
    const b = run("terse", [res({ taskId: "t1" })]);
    const summary = compareVariants(a, b);
    const parsed = JSON.parse(toAbJson([a, b], summary)) as {
      variants: VariantRun[];
      comparison: { variantA: string; variantB: string };
    };
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.comparison.variantA).toBe("control");
    expect(parsed.comparison.variantB).toBe("terse");
  });

  it("pairs repeated samples by task and sample without overwriting either result", () => {
    const summary = compareVariants(
      run("a", [res({ taskId: "t", sample: 1 }), res({ taskId: "t", sample: 2, success: false })]),
      run("b", [res({ taskId: "t", sample: 1, success: false }), res({ taskId: "t", sample: 2 })]),
    );
    expect(summary.tasks.map((row) => [row.taskId, row.sample, row.winner])).toEqual([
      ["t", 1, "a"],
      ["t", 2, "b"],
    ]);
    expect(summary.paired).toMatchObject({ pairs: 2, decisivePairs: 2, aWinRate: 0.5 });
    expect(summary.totals.a.successRateCi95.lower).toBeLessThan(0.5);
    expect(summary.totals.a.costDistribution.count).toBe(2);
  });

  it("rejects duplicate paired sample keys and alternates execution order", () => {
    expect(() => compareVariants(
      run("a", [res({ taskId: "t", sample: 1 }), res({ taskId: "t", sample: 1 })]),
      run("b", []),
    )).toThrow(/duplicate A result/);
    expect([0, 1, 2, 3].map(alternatingArmOrder)).toEqual([
      ["a", "b"], ["b", "a"], ["a", "b"], ["b", "a"],
    ]);
  });

  it("renders confidence intervals and cost distribution", () => {
    const summary = compareVariants(
      run("a", [res({ taskId: "t", sample: 1 })]),
      run("b", [res({ taskId: "t", sample: 1, success: false })]),
    );
    const markdown = toAbMarkdown(summary);
    expect(markdown).toContain("Success rate (95% CI)");
    expect(markdown).toContain("Paired Win/Loss/Tie");
    expect(markdown).toContain("Cost distribution");
  });
});
