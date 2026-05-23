import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../../src/provider/cost.js";

describe("estimateCostUsd", () => {
  it("prices cache-miss input tokens at 0.28/1M for deepseek-chat", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 },
      "deepseek-chat",
    );
    expect(cost).toBeCloseTo(0.28, 10);
  });

  it("prices cache-hit input tokens at 0.028/1M", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 1_000_000 },
      "deepseek-chat",
    );
    expect(cost).toBeCloseTo(0.028, 10);
  });

  it("prices output tokens at 0.42/1M", () => {
    const cost = estimateCostUsd(
      { promptTokens: 0, completionTokens: 1_000_000, cacheHitTokens: 0 },
      "deepseek-chat",
    );
    expect(cost).toBeCloseTo(0.42, 10);
  });

  it("combines hit/miss/output for a mixed request", () => {
    // 600k miss + 400k hit + 100k output
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 100_000, cacheHitTokens: 400_000 },
      "deepseek-chat",
    );
    expect(cost).toBeCloseTo(0.6 * 0.28 + 0.4 * 0.028 + 0.1 * 0.42, 10);
  });

  it("clamps cacheHitTokens to promptTokens", () => {
    const cost = estimateCostUsd(
      { promptTokens: 100, completionTokens: 0, cacheHitTokens: 500 },
      "deepseek-chat",
    );
    expect(cost).toBeCloseTo((100 * 0.028) / 1_000_000, 12);
  });

  it("falls back to the default model's pricing for unknown models", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 };
    // FALLBACK_PRICING_MODEL tracks DEFAULT_MODEL (deepseek-v4-flash), not the
    // deprecated deepseek-chat — so unknown ids price like the current default.
    expect(estimateCostUsd(usage, "deepseek-unknown")).toBe(
      estimateCostUsd(usage, "deepseek-v4-flash"),
    );
  });

  it("knows deepseek-reasoner", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 },
      "deepseek-reasoner",
    );
    expect(cost).toBeGreaterThan(0);
  });
});
