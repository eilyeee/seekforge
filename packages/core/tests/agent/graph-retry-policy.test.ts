import { describe, expect, it } from "vitest";
import { graphRetryDelayMs } from "../../src/agent/graph-retry-policy.js";

describe("Graph retry policy", () => {
  it("computes deterministic bounded exponential delays", () => {
    const policy = { initialDelayMs: 100, maxDelayMs: 1_000, multiplier: 2, jitterRatio: 0.2 };
    const first = graphRetryDelayMs(policy, 1, "attempt-a");
    expect(first).toBe(graphRetryDelayMs(policy, 1, "attempt-a"));
    expect(first).toBeGreaterThanOrEqual(80);
    expect(first).toBeLessThanOrEqual(120);
    expect(graphRetryDelayMs(policy, 20, "attempt-a")).toBeLessThanOrEqual(1_000);
    expect(() => graphRetryDelayMs(policy, 0, "attempt-a")).toThrow(/retry number/);
  });
});
