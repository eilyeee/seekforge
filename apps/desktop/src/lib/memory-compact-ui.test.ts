import { describe, expect, it } from "vitest";
import { MAX_MEMORY_PRUNE_DAYS, memoryCompactOptions, parseMemoryPruneDays } from "./memory-compact-ui";

describe("memory compaction UI input", () => {
  it("distinguishes omission from an explicit zero-day threshold", () => {
    expect(memoryCompactOptions("", true)).toEqual({ dryRun: true });
    expect(memoryCompactOptions("0", false)).toEqual({ dryRun: false, pruneUnusedDays: 0 });
    expect(parseMemoryPruneDays(" 60 ")).toBe(60);
  });

  it("rejects fractions, signs, overflow, and excessive duration math", () => {
    for (const value of ["-1", "+1", "1.5", "Infinity", String(MAX_MEMORY_PRUNE_DAYS + 1)]) {
      expect(() => parseMemoryPruneDays(value)).toThrow(/Prune days/);
    }
  });
});
