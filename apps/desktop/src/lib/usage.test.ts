import { describe, expect, it } from "vitest";
import { addUsage, emptyUsage, formatTokens, formatUsd } from "./usage";

describe("usage accumulator", () => {
  it("starts at zero", () => {
    expect(emptyUsage()).toEqual({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 });
  });

  it("sums all four fields", () => {
    const a = { promptTokens: 100, completionTokens: 20, cacheHitTokens: 50, costUsd: 0.001 };
    const b = { promptTokens: 200, completionTokens: 30, cacheHitTokens: 150, costUsd: 0.002 };
    expect(addUsage(a, b)).toEqual({
      promptTokens: 300,
      completionTokens: 50,
      cacheHitTokens: 200,
      costUsd: 0.003,
    });
  });

  it("does not mutate inputs", () => {
    const a = emptyUsage();
    addUsage(a, { promptTokens: 1, completionTokens: 1, cacheHitTokens: 1, costUsd: 1 });
    expect(a).toEqual(emptyUsage());
  });

  it("formats cost and token counts", () => {
    expect(formatUsd(0.00421)).toBe("$0.0042");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(15_300)).toBe("15.3k");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});
