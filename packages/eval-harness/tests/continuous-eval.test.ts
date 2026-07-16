import { describe, expect, it } from "vitest";
import { aggregateResults } from "../src/aggregate.js";
import { parseBaseline } from "../src/baseline.js";
import { evaluateGates } from "../src/gates.js";
import { toJunit } from "../src/junit.js";
import { parseSuiteConfig, type GateConfig } from "../src/suite-config.js";
import type { TaskResult } from "../src/task-runner.js";

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    taskId: "task-a",
    success: true,
    checks: [{ check: { type: "answer_matches", pattern: "ok" }, passed: true }],
    metrics: {
      toolCalls: 10,
      failedToolCalls: 1,
      costUsd: 0.02,
      promptTokens: 100,
      completionTokens: 50,
      cacheHitTokens: 25,
      totalTokens: 150,
      durationMs: 1000,
    },
    skills: [],
    ...overrides,
  };
}

const gates: GateConfig = {
  minSuccessRate: 0.5,
  maxSuccessRateDrop: 0.1,
  maxCostPerSuccessUsd: 0.1,
  maxCostPerSuccessIncreaseRatio: 0.5,
  maxTokensPerSuccess: 1000,
  maxTokensPerSuccessIncreaseRatio: 0.5,
  maxToolFailureRate: 0.2,
  maxToolFailureRateIncrease: 0.1,
  maxSessionErrorRate: 0.2,
};

describe("continuous eval aggregation", () => {
  it("aggregates repeated samples without NaN on zero denominators", () => {
    const aggregate = aggregateResults([
      result({ sample: 1 }),
      result({
        sample: 2,
        success: false,
        error: "failed",
        metrics: {
          toolCalls: 0,
          failedToolCalls: 0,
          costUsd: 0.01,
          promptTokens: 20,
          completionTokens: 10,
          cacheHitTokens: 0,
          totalTokens: 30,
          durationMs: 500,
        },
      }),
    ]);
    expect(aggregate.samples).toBe(2);
    expect(aggregate.successRate).toBe(0.5);
    expect(aggregate.sessionErrorRate).toBe(0.5);
    expect(aggregate.toolFailureRate).toBe(0.1);
    expect(aggregate.totalTokens).toBe(180);
    expect(aggregate.costPerSuccessUsd).toBeCloseTo(0.03);
    expect(aggregateResults([])).toMatchObject({
      samples: 0,
      successRate: 0,
      toolFailureRate: 0,
      costPerSuccessUsd: null,
      tokensPerSuccess: null,
    });
  });
});

describe("baseline validation and gates", () => {
  it("accepts legacy reports but rejects empty, non-finite, and inconsistent metrics", () => {
    const legacy = result();
    delete legacy.metrics.promptTokens;
    delete legacy.metrics.completionTokens;
    delete legacy.metrics.cacheHitTokens;
    delete legacy.metrics.totalTokens;
    expect(parseBaseline(JSON.stringify({ results: [legacy] }))).toHaveLength(1);
    expect(() => parseBaseline('{"results":[]}')).toThrow(/must not be empty/);
    expect(() => parseBaseline('{"results":[{"taskId":"x"}]}')).toThrow(/success/);
    expect(() =>
      parseBaseline(
        JSON.stringify({
          results: [
            result({
              metrics: { ...result().metrics, costUsd: -1 },
            }),
          ],
        }),
      ),
    ).toThrow(/costUsd/);
    expect(() =>
      parseBaseline(
        '{"results":[{"taskId":"x","success":true,"checks":[],"metrics":{"toolCalls":1,"failedToolCalls":0,"costUsd":1e999,"durationMs":1}}]}',
      ),
    ).toThrow(/costUsd/);
    expect(() =>
      parseBaseline(
        JSON.stringify({
          results: [
            result({
              metrics: { ...result().metrics, totalTokens: 999 },
            }),
          ],
        }),
      ),
    ).toThrow(/totalTokens/);
    const partialTokens = result();
    delete partialTokens.metrics.totalTokens;
    expect(() => parseBaseline(JSON.stringify({ results: [partialTokens] }))).toThrow(/all present or all absent/);
    expect(() =>
      parseBaseline(
        JSON.stringify({
          results: [
            {
              ...result(),
              execution: { runner: "unknown", status: "done", expectedStatus: "done", passed: true, sessionIds: [] },
            },
          ],
        }),
      ),
    ).toThrow(/orchestration shape/);
  });

  it("fails quality, efficiency, and reliability gates including empty samples", () => {
    expect(evaluateGates([result()], gates).passed).toBe(true);
    const bad = result({
      success: false,
      error: "session failed",
      metrics: { ...result().metrics, failedToolCalls: 9, costUsd: 2, totalTokens: 2000 },
    });
    const evaluated = evaluateGates([bad], gates);
    expect(evaluated.passed).toBe(false);
    expect(evaluated.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "success rate",
        "cost per success",
        "tokens per success",
        "tool failure rate",
        "session error rate",
      ]),
    );
    expect(evaluateGates([], gates).passed).toBe(false);
  });

  it("skips only the relative token gate for a legacy baseline", () => {
    const legacy = result();
    delete legacy.metrics.promptTokens;
    delete legacy.metrics.completionTokens;
    delete legacy.metrics.cacheHitTokens;
    delete legacy.metrics.totalTokens;
    const evaluated = evaluateGates([result()], gates, JSON.stringify({ results: [legacy] }));
    expect(evaluated.checks.some((check) => check.name === "tokens-per-success increase")).toBe(false);
    expect(evaluated.checks.some((check) => check.name === "cost-per-success increase")).toBe(true);
  });

  it("compares baseline-relative gates only across matching task ids", () => {
    const unrelatedExpensive = result({
      taskId: "other",
      metrics: {
        ...result().metrics,
        costUsd: 100,
        promptTokens: 80000,
        completionTokens: 20000,
        cacheHitTokens: 0,
        totalTokens: 100000,
      },
    });
    const evaluated = evaluateGates(
      [result({ taskId: "selected" })],
      gates,
      JSON.stringify({ results: [result({ taskId: "selected" }), unrelatedExpensive] }),
    );
    const cost = evaluated.checks.find((check) => check.name === "cost-per-success increase");
    expect(cost?.actual).toBeCloseTo(0);
  });
});

describe("suite config and JUnit", () => {
  it("strictly validates suites and finite gate values", () => {
    const parsed = parseSuiteConfig({ version: 1, suites: { smoke: { tasks: ["a", "a"], repeat: 1, gates } } });
    expect(parsed.suites["smoke"]?.tasks).toEqual(["a"]);
    expect(() => parseSuiteConfig({ version: 1, suites: { bad: { tasks: [], repeat: 0, gates } } })).toThrow();
    expect(() => parseSuiteConfig({ version: 1, suites: { bad: { tasks: "*", repeat: 21, gates } } })).toThrow(
      /1 to 20/,
    );
    expect(() =>
      parseSuiteConfig({
        version: 1,
        suites: { bad: { tasks: "*", repeat: 1, gates: { ...gates, maxTokensPerSuccess: Number.NaN } } },
      }),
    ).toThrow(/finite/);
  });

  it("writes failures, errors, timings, and escaped task names to JUnit", () => {
    const xml = toJunit([
      result({ taskId: "a<&", sample: 1 }),
      result({
        taskId: "failed",
        success: false,
        checks: [
          {
            check: { type: "answer_matches", pattern: "x" },
            passed: false,
            detail: "bad < output",
          },
        ],
      }),
      result({ taskId: "error", success: false, error: "API & timeout" }),
    ]);
    expect(xml).toContain('tests="3" failures="1" errors="1"');
    expect(xml).toContain("a&lt;&amp; sample 1");
    expect(xml).toContain("bad &lt; output");
    expect(xml).toContain("API &amp; timeout");
  });
});
