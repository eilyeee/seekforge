import { describe, expect, it } from "vitest";
import {
  assertAutoCompactThreshold,
  assertModelContextWindows,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  resolveContextWindow,
} from "../../src/provider/index.js";

describe("resolveContextWindow", () => {
  it("knows the large-window models", () => {
    expect(resolveContextWindow("claude-opus-5")).toBe(1_000_000);
    expect(resolveContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
    expect(resolveContextWindow("deepseek-v4-pro")).toBe(1_000_000);
    expect(resolveContextWindow("deepseek-v4-flash")).toBe(1_000_000);
    expect(resolveContextWindow("deepseek-flash")).toBe(1_000_000);
  });

  it("keeps the smaller windows smaller", () => {
    expect(resolveContextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(resolveContextWindow("deepseek-chat")).toBe(131_072);
    // An older Claude family falls back to the generic claude- entry, and the
    // 4-6 entry does not leak onto 4-5.
    expect(resolveContextWindow("claude-sonnet-4-5")).toBe(200_000);
    expect(resolveContextWindow("claude-3-7-sonnet-latest")).toBe(200_000);
  });

  it("matches dated, versioned and routed ids to their family", () => {
    expect(resolveContextWindow("claude-opus-5-20260101")).toBe(1_000_000);
    expect(resolveContextWindow("claude-fable-5-1")).toBe(1_000_000);
    expect(resolveContextWindow("us.anthropic.claude-opus-4-8-v1:0")).toBe(1_000_000);
    expect(resolveContextWindow("anthropic/claude-sonnet-5")).toBe(1_000_000);
    expect(resolveContextWindow("deepseek/deepseek-v4-pro")).toBe(1_000_000);
    expect(resolveContextWindow("Claude-Opus-5")).toBe(1_000_000);
  });

  it("only matches a prefix at a separator", () => {
    // "claude-opus-50" is not a claude-opus-5 variant; it is still a Claude id.
    expect(resolveContextWindow("claude-opus-50")).toBe(200_000);
    expect(resolveContextWindow("deepseek-v40")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it("uses the conservative default for unknown models", () => {
    expect(resolveContextWindow("gpt-5.4")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(resolveContextWindow("qwen3-coder")).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(131_072);
  });

  it("lets an exact-id override win over the table", () => {
    expect(resolveContextWindow("claude-opus-5", { "claude-opus-5": 200_000 })).toBe(200_000);
    expect(resolveContextWindow("qwen3-coder", { "qwen3-coder": 262_144 })).toBe(262_144);
    // Overrides are exact: no family matching, no inherited keys.
    expect(resolveContextWindow("claude-opus-5-20260101", { "claude-opus-5": 200_000 })).toBe(1_000_000);
    expect(resolveContextWindow("toString", {})).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });
});

describe("config validation", () => {
  it("accepts well-formed context-window maps", () => {
    expect(() => assertModelContextWindows(undefined)).not.toThrow();
    expect(() => assertModelContextWindows({ "my-model": 32_768 })).not.toThrow();
  });

  it.each([null, [], "128000", { m: 0 }, { m: -1 }, { m: 1.5 }, { m: "8k" }, { m: Number.POSITIVE_INFINITY }])(
    "rejects modelContextWindows %j",
    (value) => {
      expect(() => assertModelContextWindows(value)).toThrow(RangeError);
    },
  );

  it("accepts thresholds in (0, 1]", () => {
    expect(() => assertAutoCompactThreshold(undefined)).not.toThrow();
    expect(() => assertAutoCompactThreshold(1)).not.toThrow();
    expect(() => assertAutoCompactThreshold(0.5)).not.toThrow();
  });

  it.each([0, -0.1, 1.01, Number.NaN, "0.9"])("rejects autoCompactThreshold %j", (value) => {
    expect(() => assertAutoCompactThreshold(value)).toThrow(/autoCompactThreshold/);
  });
});
