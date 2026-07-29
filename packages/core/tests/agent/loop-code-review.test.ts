import { describe, expect, it } from "vitest";
import {
  createLoopWorkingMemory,
  parseLoopCodeReview,
  parseLoopWorkingMemory,
} from "../../src/agent/loop-code-review.js";

describe("Loop code review contracts", () => {
  it("accepts a bounded exact review and binds completion to an empty finding list", () => {
    expect(parseLoopCodeReview({ complete: true, summary: "clean", findings: [] })).toEqual({
      complete: true,
      summary: "clean",
      findings: [],
    });
    expect(
      parseLoopCodeReview({
        complete: true,
        summary: "incorrect",
        findings: [{ id: "one", priority: 2, title: "Issue", body: "Fix it" }],
      }),
    ).toBeNull();
    expect(parseLoopCodeReview({ complete: true, summary: "clean", findings: [], extra: true })).toBeNull();
    expect(
      parseLoopCodeReview({
        complete: false,
        summary: "bad id",
        findings: [{ id: 1, priority: 1, title: "Issue", body: "Fix it" }],
      }),
    ).toBeNull();
  });

  it("deduplicates and bounds working-memory evidence", () => {
    const memory = createLoopWorkingMemory({
      iteration: 2,
      workspaceFingerprint: "a".repeat(64),
      failureCategory: "test",
      failedTests: 1,
      changedPaths: ["a.ts", "a.ts"],
      acceptanceGaps: ["AC-1", "AC-1"],
      reviewFindings: ["finding-1", "finding-1"],
    });
    expect(memory.changedPaths).toEqual(["a.ts"]);
    expect(parseLoopWorkingMemory(memory)).toEqual(memory);
    expect(parseLoopWorkingMemory({ ...memory, extra: true })).toBeNull();
    expect(parseLoopWorkingMemory({ ...memory, changedPaths: ["a.ts", "a.ts"] })).toBeNull();
    expect(
      createLoopWorkingMemory({
        ...memory,
        failureCategory: "invented",
        changedPaths: ["../outside", "safe.ts"],
        acceptanceGaps: ["bad/id", "AC-1"],
        reviewFindings: ["bad/id", "finding-1"],
      }),
    ).toMatchObject({
      failureCategory: "unknown",
      changedPaths: ["safe.ts"],
      acceptanceGaps: ["AC-1"],
      reviewFindings: ["finding-1"],
    });
  });
});
