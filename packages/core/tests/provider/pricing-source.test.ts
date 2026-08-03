import { describe, expect, it } from "vitest";
import { estimateCostUsd, pricingSourceFor } from "../../src/provider/index.js";

/**
 * A reported cost of 0 is indistinguishable from a call that was free. These
 * cover the one question a frontend has to be able to answer before it prints
 * a number: is this price known, or merely absent?
 */

const TOKENS = { promptTokens: 1_000, completionTokens: 500, cacheHitTokens: 0 };

describe("where a model's price comes from", () => {
  it("prefers what the user configured", () => {
    const pricing = { "doubao-seed-2.0-pro": { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0.1, outputPer1M: 2 } };
    expect(pricingSourceFor("doubao-seed-2.0-pro", { pricing, costAccounting: false })).toBe("configured");
    expect(estimateCostUsd(TOKENS, "doubao-seed-2.0-pro", pricing)).toBeCloseTo(0.002);
  });

  it("uses the built-in table for a model it knows", () => {
    expect(pricingSourceFor("deepseek-v4-flash")).toBe("builtin");
    expect(pricingSourceFor("deepseek-v4-pro", { costAccounting: true })).toBe("builtin");
  });

  it("reports a provider with no pricing at all as unavailable, not as free", () => {
    // Every non-DeepSeek preset sets costAccounting: false — no built-in table
    // applies, so without a configured price nothing can be said about cost.
    expect(pricingSourceFor("doubao-seed-2.0-pro", { costAccounting: false })).toBe("unavailable");
    expect(pricingSourceFor("gpt-nonexistent", { costAccounting: false })).toBe("unavailable");
  });

  it("admits when an unknown DeepSeek model is being priced as the default", () => {
    // It still produces a number, but the caller can tell it is an estimate
    // borrowed from another model rather than this one's real price.
    expect(pricingSourceFor("deepseek-v9-imaginary", { costAccounting: true })).toBe("fallback");
    expect(estimateCostUsd(TOKENS, "deepseek-v9-imaginary")).toBeGreaterThan(0);
  });

  it("a configured price wins even where a built-in one exists", () => {
    const pricing = { "deepseek-v4-flash": { inputCacheMissPer1M: 99, inputCacheHitPer1M: 0, outputPer1M: 99 } };
    expect(pricingSourceFor("deepseek-v4-flash", { pricing })).toBe("configured");
    expect(estimateCostUsd(TOKENS, "deepseek-v4-flash", pricing)).toBeCloseTo(0.1485);
  });
});
