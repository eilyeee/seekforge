import { describe, expect, it } from "vitest";
import { nextFinalizeNudge, type FinalizeKind, type FinalizeState } from "../../src/agent/finalize.js";
import type { PlanItem } from "../../src/tools/builtins/plan.js";

function state(overrides: Partial<FinalizeState>): FinalizeState {
  return {
    changedFiles: 0,
    verifyRanSinceEdit: false,
    reviewEnabled: false,
    fired: new Set<FinalizeKind>(),
    ...overrides,
  };
}

const plan = (statuses: PlanItem["status"][]): PlanItem[] =>
  statuses.map((status, i) => ({ step: `step ${i}`, status }));

describe("nextFinalizeNudge", () => {
  it("returns null when there is nothing left to do", () => {
    expect(nextFinalizeNudge(state({}))).toBeNull();
    // edits made but no verify command and review disabled = clean finish
    expect(nextFinalizeNudge(state({ changedFiles: 3 }))).toBeNull();
  });

  it("nudges to finish a plan with open steps, listing them", () => {
    const n = nextFinalizeNudge(state({ planItems: plan(["done", "in_progress", "pending"]) }));
    expect(n?.kind).toBe("plan");
    expect(n?.message).toContain("2 step(s) are not done");
    expect(n?.message).toContain("(in_progress)");
    expect(n?.message).toContain("(pending)");
  });

  it("does not nudge for a fully-done plan", () => {
    expect(nextFinalizeNudge(state({ planItems: plan(["done", "done"]) }))).toBeNull();
  });

  it("nudges to run the verify command when edits are unverified", () => {
    const n = nextFinalizeNudge(state({ changedFiles: 2, verifyCommand: "pnpm test" }));
    expect(n?.kind).toBe("verify");
    expect(n?.message).toContain("pnpm test");
    expect(n?.message).toContain("2 file(s)");
  });

  it("does not nudge verify when nothing was edited", () => {
    expect(nextFinalizeNudge(state({ changedFiles: 0, verifyCommand: "pnpm test" }))).toBeNull();
  });

  it("does not nudge verify when it already ran since the last edit", () => {
    expect(
      nextFinalizeNudge(state({ changedFiles: 2, verifyCommand: "pnpm test", verifyRanSinceEdit: true })),
    ).toBeNull();
  });

  it("ignores a blank verify command", () => {
    expect(nextFinalizeNudge(state({ changedFiles: 2, verifyCommand: "   " }))).toBeNull();
  });

  it("nudges a self-review only when enabled and edits were made", () => {
    expect(nextFinalizeNudge(state({ changedFiles: 1, reviewEnabled: true }))?.kind).toBe("review");
    expect(nextFinalizeNudge(state({ changedFiles: 0, reviewEnabled: true }))).toBeNull();
    expect(nextFinalizeNudge(state({ changedFiles: 1, reviewEnabled: false }))).toBeNull();
  });

  it("prioritises finishing the plan over verifying or reviewing", () => {
    const n = nextFinalizeNudge(
      state({
        planItems: plan(["pending"]),
        changedFiles: 1,
        verifyCommand: "pnpm test",
        reviewEnabled: true,
      }),
    );
    expect(n?.kind).toBe("plan");
  });

  it("prioritises verify over review once the plan is done", () => {
    const n = nextFinalizeNudge(
      state({
        planItems: plan(["done"]),
        changedFiles: 1,
        verifyCommand: "pnpm test",
        reviewEnabled: true,
      }),
    );
    expect(n?.kind).toBe("verify");
  });

  it("each kind fires at most once (skips already-fired checks)", () => {
    const base = {
      planItems: plan(["pending"]),
      changedFiles: 1,
      verifyCommand: "pnpm test",
      reviewEnabled: true,
    };
    // plan already fired -> falls through to verify
    expect(nextFinalizeNudge(state({ ...base, fired: new Set(["plan"]) }))?.kind).toBe("verify");
    // plan + verify fired -> falls through to review
    expect(nextFinalizeNudge(state({ ...base, fired: new Set(["plan", "verify"]) }))?.kind).toBe("review");
    // all fired -> clean finish (guarantees termination)
    expect(nextFinalizeNudge(state({ ...base, fired: new Set(["plan", "verify", "review"]) }))).toBeNull();
  });
});
