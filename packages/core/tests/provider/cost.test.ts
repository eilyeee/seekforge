import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "../../src/provider/cost.js";

describe("estimateCostUsd", () => {
  it("prices cache-miss input tokens at 0.28/1M for deepseek-chat", () => {
    const cost = estimateCostUsd({ promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 }, "deepseek-chat");
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
    const cost = estimateCostUsd({ promptTokens: 0, completionTokens: 1_000_000, cacheHitTokens: 0 }, "deepseek-chat");
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
    const cost = estimateCostUsd({ promptTokens: 100, completionTokens: 0, cacheHitTokens: 500 }, "deepseek-chat");
    expect(cost).toBeCloseTo((100 * 0.028) / 1_000_000, 12);
  });

  it("falls back to the default model's pricing for unknown models", () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 };
    // FALLBACK_PRICING_MODEL tracks DEFAULT_MODEL (deepseek-v4-flash), not the
    // deprecated deepseek-chat — so unknown ids price like the current default.
    expect(estimateCostUsd(usage, "deepseek-unknown")).toBe(estimateCostUsd(usage, "deepseek-v4-flash"));
  });

  it("knows deepseek-reasoner", () => {
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 },
      "deepseek-reasoner",
    );
    expect(cost).toBeGreaterThan(0);
  });

  it("uses an explicit pricing override for the model when provided", () => {
    // Example placeholder rates (NOT real prices) for a provider with no
    // built-in table (e.g. an Ark model id).
    const pricing = {
      "ark-model-x": { inputCacheMissPer1M: 2, inputCacheHitPer1M: 0.5, outputPer1M: 6 },
    };
    const cost = estimateCostUsd(
      { promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 400_000 },
      "ark-model-x",
      pricing,
    );
    // 600k miss * 2 + 400k hit * 0.5 + 1M output * 6, per 1M tokens.
    expect(cost).toBeCloseTo((600_000 * 2 + 400_000 * 0.5 + 1_000_000 * 6) / 1_000_000, 10);
  });

  it("falls back to the built-in table when the override lacks the model", () => {
    const pricing = {
      "some-other-model": { inputCacheMissPer1M: 99, inputCacheHitPer1M: 99, outputPer1M: 99 },
    };
    const usage = { promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 0 };
    expect(estimateCostUsd(usage, "deepseek-chat", pricing)).toBe(estimateCostUsd(usage, "deepseek-chat"));
  });

  it("never returns a non-finite or negative cost", () => {
    const usage = {
      promptTokens: Number.MAX_SAFE_INTEGER,
      completionTokens: Number.MAX_SAFE_INTEGER,
      cacheHitTokens: 0,
    };
    const invalidPricing = {
      huge: {
        inputCacheMissPer1M: Number.MAX_VALUE,
        inputCacheHitPer1M: Number.MAX_VALUE,
        outputPer1M: Number.MAX_VALUE,
      },
      negative: { inputCacheMissPer1M: -1, inputCacheHitPer1M: -1, outputPer1M: -1 },
    };

    expect(estimateCostUsd(usage, "huge", invalidPricing)).toBe(0);
    expect(estimateCostUsd(usage, "negative", invalidPricing)).toBe(0);
  });
});
