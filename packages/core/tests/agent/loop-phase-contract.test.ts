import { describe, expect, it } from "vitest";
import type { LoopStateSummary } from "@seekforge/shared";
import { createLoopState, saveLoopState, loadLoopState } from "../../src/agent/loop-state.js";
import type { LoopPhase } from "../../src/agent/loop-state.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `phase` was declared twice — once in Core, once in the shared DTO the server
 * returns verbatim — and the copies disagreed: a `--code-review` Loop persists
 * `phase: "review"`, which the shared union could not describe. Nothing crashed,
 * because a union is erased at runtime; the type simply lied about a value the
 * wire carries. Core now aliases the shared declaration, and this pins both ends.
 */
describe("LoopPhase is one contract, not two", () => {
  it("lets the shared DTO describe every phase Core can persist", () => {
    const phases: LoopPhase[] = [
      "requirements",
      "precheck",
      "editing",
      "verification",
      "acceptance",
      "review",
      "settled",
    ];
    // Assignable in both directions: the alias would not compile if either side
    // gained a member the other lacks.
    const asSummaryPhases: NonNullable<LoopStateSummary["phase"]>[] = phases;
    expect(asSummaryPhases).toContain("review");
  });

  it("round-trips a review phase through the persisted store", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-phase-"));
    try {
      const state = createLoopState({
        loopId: "phase-review",
        task: "t",
        workspace,
        verifyCommand: "true",
        maxIterations: 1,
      });
      saveLoopState(workspace, { ...state, phase: "review" });
      expect(loadLoopState(workspace, "phase-review")?.phase).toBe("review");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
