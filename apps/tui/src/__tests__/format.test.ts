import { describe, expect, it } from "vitest";
import { formatUsage, kfmt, planGlyph, statusBarParts, summarizeArgs } from "../format.js";

describe("kfmt", () => {
  it("formats thousands compactly", () => {
    expect(kfmt(999)).toBe("999");
    expect(kfmt(1000)).toBe("1.0K");
    expect(kfmt(12_340)).toBe("12.3K");
  });
});

describe("formatUsage", () => {
  it("renders prompt/cache/completion tokens and 4dp cost", () => {
    const s = formatUsage({ promptTokens: 1500, completionTokens: 800, cacheHitTokens: 1000, costUsd: 0.0123 });
    expect(s).toContain("1.5K prompt (1.0K cache hit)");
    expect(s).toContain("800 completion");
    expect(s).toContain("$0.0123");
  });
});

describe("summarizeArgs", () => {
  it("truncates long args with an ellipsis", () => {
    const out = summarizeArgs({ x: "a".repeat(200) });
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(121);
  });
  it("passes short args verbatim", () => {
    expect(summarizeArgs({ a: 1 })).toBe('{"a":1}');
  });
});

describe("statusBarParts", () => {
  it("derives occupancy %, cost, and total tokens", () => {
    const parts = statusBarParts({
      model: "deepseek-chat",
      context: { usedTokens: 80, budgetTokens: 100, percent: 80 },
      usage: { promptTokens: 1200, completionTokens: 300, cacheHitTokens: 0, costUsd: 0.05 },
      running: true,
    });
    expect(parts.model).toBe("deepseek-chat");
    expect(parts.context).toBe("ctx 80%");
    expect(parts.cost).toBe("$0.0500");
    expect(parts.tokens).toBe("1.5K tok");
    expect(parts.state).toBe("working");
  });

  it("omits context when no turn has run and reports idle", () => {
    const parts = statusBarParts({
      model: "m",
      usage: { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 },
      running: false,
    });
    expect(parts.context).toBeUndefined();
    expect(parts.state).toBe("idle");
  });

  it("surfaces non-default approval modes and running bg tasks", () => {
    const usage = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 };
    expect(statusBarParts({ model: "m", usage, running: false }).approval).toBeUndefined();
    expect(statusBarParts({ model: "m", usage, running: false, approval: "confirm" }).approval).toBeUndefined();
    expect(statusBarParts({ model: "m", usage, running: false, approval: "auto" }).approval).toBe("auto-approve");
    expect(statusBarParts({ model: "m", usage, running: false, approval: "plan" }).approval).toBe("plan mode");
    expect(statusBarParts({ model: "m", usage, running: false, bgRunning: 2 }).bg).toBe("⚙ 2 bg");
    expect(statusBarParts({ model: "m", usage, running: false, bgRunning: 0 }).bg).toBeUndefined();
  });
});

describe("planGlyph", () => {
  it("maps statuses to checklist glyphs", () => {
    expect(planGlyph("done")).toBe("☑");
    expect(planGlyph("in_progress")).toBe("◐");
    expect(planGlyph("pending")).toBe("☐");
    expect(planGlyph("weird")).toBe("☐");
  });
});
