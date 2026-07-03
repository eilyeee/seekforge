import { describe, expect, it } from "vitest";
import { nextFinalizeNudge, type FinalizeKind, type FinalizeState } from "../../src/agent/finalize.js";
import type { PlanItem } from "../../src/tools/builtins/plan.js";

function state(overrides: Partial<FinalizeState>): FinalizeState {
  return {
    mode: "edit",
    toolCalls: 5, // above the progress threshold unless a test overrides it
    changedFiles: 0,
    verifyRanSinceEdit: false,
    lintRanSinceEdit: false,
    reviewEnabled: false,
    guardNoProgress: false,
    fired: new Set<FinalizeKind>(),
    ...overrides,
  };
}

const plan = (statuses: PlanItem["status"][]): PlanItem[] =>
  statuses.map((status, i) => ({ step: `step ${i}`, status }));

describe("nextFinalizeNudge", () => {
  it("flags a premature bail-out: edit mode, no changes, ~no tool calls (when enabled)", () => {
    expect(nextFinalizeNudge(state({ guardNoProgress: true, toolCalls: 0, changedFiles: 0 }))?.kind).toBe("progress");
    expect(nextFinalizeNudge(state({ guardNoProgress: true, toolCalls: 1, changedFiles: 0 }))?.kind).toBe("progress");
  });

  it("the progress guard is off by default", () => {
    expect(nextFinalizeNudge(state({ toolCalls: 0, changedFiles: 0 }))).toBeNull();
  });

  it("does NOT flag progress when the agent investigated (enough tool calls)", () => {
    expect(nextFinalizeNudge(state({ guardNoProgress: true, toolCalls: 5, changedFiles: 0 }))).toBeNull();
  });

  it("does NOT flag progress in ask mode", () => {
    expect(nextFinalizeNudge(state({ guardNoProgress: true, mode: "ask", toolCalls: 0, changedFiles: 0 }))).toBeNull();
  });

  it("progress fires before plan/verify/review and only once", () => {
    const base = { guardNoProgress: true, toolCalls: 0, changedFiles: 0, planItems: plan(["pending"]) };
    expect(nextFinalizeNudge(state(base))?.kind).toBe("progress");
    // once spent, it falls through to the plan check
    expect(nextFinalizeNudge(state({ ...base, fired: new Set(["progress"]) }))?.kind).toBe("plan");
  });

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

  it("nudges to run the lint command when edits are unlinted", () => {
    const n = nextFinalizeNudge(state({ changedFiles: 2, lintCommand: "pnpm lint" }));
    expect(n?.kind).toBe("lint");
    expect(n?.message).toContain("pnpm lint");
    expect(n?.message).toContain("2 file(s)");
  });

  it("does not nudge lint when nothing was edited", () => {
    expect(nextFinalizeNudge(state({ changedFiles: 0, lintCommand: "pnpm lint" }))).toBeNull();
  });

  it("does not nudge lint when it already ran since the last edit", () => {
    expect(
      nextFinalizeNudge(state({ changedFiles: 2, lintCommand: "pnpm lint", lintRanSinceEdit: true })),
    ).toBeNull();
  });

  it("ignores a blank lint command", () => {
    expect(nextFinalizeNudge(state({ changedFiles: 2, lintCommand: "   " }))).toBeNull();
  });

  it("prioritises verify over lint, and lint over review", () => {
    // verify + lint both pending -> verify wins
    expect(
      nextFinalizeNudge(
        state({ changedFiles: 1, verifyCommand: "pnpm test", lintCommand: "pnpm lint" }),
      )?.kind,
    ).toBe("verify");
    // verify done (ran since edit) -> lint wins over review
    expect(
      nextFinalizeNudge(
        state({
          changedFiles: 1,
          verifyCommand: "pnpm test",
          verifyRanSinceEdit: true,
          lintCommand: "pnpm lint",
          reviewEnabled: true,
        }),
      )?.kind,
    ).toBe("lint");
    // lint already fired -> falls through to review
    expect(
      nextFinalizeNudge(
        state({
          changedFiles: 1,
          lintCommand: "pnpm lint",
          reviewEnabled: true,
          fired: new Set(["lint"]),
        }),
      )?.kind,
    ).toBe("review");
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
