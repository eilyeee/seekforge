import { describe, expect, it } from "vitest";
import {
  formatDuration,
  formatUsage,
  formatUsageDetail,
  kfmt,
  planGlyph,
  relativeAge,
  statusBarParts,
  summarizeArgs,
} from "../format.js";

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

describe("formatUsageDetail", () => {
  const usage = { promptTokens: 1500, completionTokens: 800, cacheHitTokens: 1000, costUsd: 0.0123 };

  it("renders labeled prompt/completion/total/cost lines with the cache-hit rate", () => {
    expect(formatUsageDetail(usage)).toEqual([
      "prompt      1.5K tokens (1.0K cache hit · 67% hit rate)",
      "completion  800 tokens",
      "total       2.3K tokens",
      "cost        $0.0123",
    ]);
  });

  it("appends duration and turns when provided", () => {
    const lines = formatUsageDetail(usage, { durationMs: 192_000, turns: 4 });
    expect(lines).toContain("duration    3m 12s");
    expect(lines).toContain("turns       4");
    expect(lines).toHaveLength(6);
  });

  it("reports a 0% hit rate when no prompt tokens were used", () => {
    const [prompt] = formatUsageDetail({ promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, costUsd: 0 });
    expect(prompt).toContain("0% hit rate");
  });
});

describe("formatDuration", () => {
  it("uses at most two units per magnitude", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
  });

  it("clamps negatives and sub-second values to 0s", () => {
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(800)).toBe("0s");
  });
});

describe("relativeAge", () => {
  const now = Date.parse("2026-06-12T12:00:00.000Z");

  it("buckets ages into just now / m / h / d / mo", () => {
    expect(relativeAge("2026-06-12T11:59:30.000Z", now)).toBe("just now");
    expect(relativeAge("2026-06-12T11:55:00.000Z", now)).toBe("5m ago");
    expect(relativeAge("2026-06-12T10:00:00.000Z", now)).toBe("2h ago");
    expect(relativeAge("2026-06-09T12:00:00.000Z", now)).toBe("3d ago");
    expect(relativeAge("2026-04-01T12:00:00.000Z", now)).toBe("2mo ago");
  });

  it("returns a dash for invalid or future timestamps", () => {
    expect(relativeAge("not-a-date", now)).toBe("—");
    expect(relativeAge("2027-01-01T00:00:00.000Z", now)).toBe("—");
  });

  it("accepts a Date for now", () => {
    expect(relativeAge("2026-06-12T11:00:00.000Z", new Date(now))).toBe("1h ago");
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
