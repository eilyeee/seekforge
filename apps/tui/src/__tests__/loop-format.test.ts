import { describe, expect, it } from "vitest";
import type { LoopEvent, LoopResult, LoopStageResult } from "@seekforge/core";
import {
  formatLoopEvent,
  formatLoopSummary,
  loopOutputTail,
  loopStatusTone,
  shouldRenderLoopEvent,
} from "../loop-format.js";

function result(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    status: "passed",
    iterations: 1,
    costUsd: 0,
    sessionId: "sess-1",
    finalVerify: { code: 0, output: "" },
    ...overrides,
  };
}

describe("formatLoopEvent warnings", () => {
  it("surfaces persistence warnings", () => {
    expect(formatLoopEvent({ type: "loop.warning", warning: "persistence", message: "disk full" })).toEqual([
      { text: "  ! loop persistence warning: disk full", tone: "error" },
    ]);
  });

  it("labels requirement warnings separately", () => {
    expect(formatLoopEvent({ type: "loop.warning", warning: "requirements", message: "invalid review" })).toEqual([
      { text: "  ! loop requirement warning: invalid review", tone: "error" },
    ]);
  });

  it("labels incremental verification notices as observer warnings", () => {
    expect(formatLoopEvent({ type: "loop.warning", warning: "observer", message: "running full pipeline" })).toEqual([
      { text: "  ! loop observer warning: running full pipeline", tone: "error" },
    ]);
  });
});

describe("detached Loop events", () => {
  it("streams foreground progress but only the final event after detach", () => {
    const progress = { type: "iteration.start", iteration: 1 } as const;
    const done = { type: "loop.done", result: result() } as const;
    expect(shouldRenderLoopEvent(progress, true, false)).toBe(true);
    expect(shouldRenderLoopEvent(progress, false, true)).toBe(false);
    expect(shouldRenderLoopEvent(done, false, true)).toBe(true);
    expect(shouldRenderLoopEvent(done, false, false)).toBe(false);
  });
});

describe("loopOutputTail", () => {
  it("returns the last non-empty line, trimmed", () => {
    expect(loopOutputTail("first\nsecond\n\n  \n")).toBe("second");
  });

  it("returns '' for blank output", () => {
    expect(loopOutputTail("\n  \n")).toBe("");
  });

  it("clips a long line with an ellipsis", () => {
    const out = loopOutputTail("x".repeat(500), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not split a surrogate pair at the clip boundary", () => {
    // Each 😀 is two code units; a naive slice at max-1 would keep a lone high
    // surrogate (rendered as �). max=10 lands the cut mid-pair.
    const out = loopOutputTail("😀".repeat(20), 10);
    expect(out.endsWith("…")).toBe(true);
    // The char before the ellipsis must not be a lone high surrogate.
    const beforeEllipsis = out.charCodeAt(out.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
    // Body (sans ellipsis) is an even number of code units — no split pair.
    expect((out.length - 1) % 2).toBe(0);
  });
});

describe("formatLoopEvent exhaustiveness", () => {
  it("returns [] for an unknown/future event variant (never undefined)", () => {
    const unknown = { type: "future.variant" } as unknown as LoopEvent;
    expect(formatLoopEvent(unknown)).toEqual([]);
  });

  it("stays silent for the per-iteration bookkeeping events", () => {
    const silent: LoopEvent[] = [
      { type: "verify.stage.started", iteration: 1, stageId: "unit", attempt: 1 },
      {
        type: "loop.snapshot",
        snapshot: {
          iteration: 1,
          ts: "2026-01-01T00:00:00.000Z",
          diagnosticsFingerprint: "fp",
          workspaceFingerprint: null,
          failedTests: 2,
          stageResults: [],
        },
      },
      {
        type: "loop.memory.updated",
        memory: {
          iteration: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          workspaceFingerprint: null,
          failureCategory: "test",
          failedTests: 2,
          changedPaths: [],
          acceptanceGaps: [],
          reviewFindings: [],
        },
      },
    ];
    for (const event of silent) expect(formatLoopEvent(event)).toEqual([]);
  });
});

describe("formatLoopEvent workspace mutations", () => {
  it("reports a regression rollback as an error line naming the undone edits", () => {
    expect(
      formatLoopEvent({ type: "loop.rollback", iteration: 3, restored: ["a.ts", "b.ts"], deleted: ["c.ts"] }),
    ).toEqual([
      {
        text: "  ↩ loop · iteration 3 rolled back — its edits were undone (restored 2, deleted 1); re-verifying",
        tone: "error",
      },
    ]);
  });
});

describe("formatLoopEvent control acknowledgements", () => {
  it("confirms the pause once the safe boundary is reached", () => {
    expect(formatLoopEvent({ type: "loop.paused", iteration: 4 })).toEqual([
      { text: "  ⏸ loop paused at the iteration 4 boundary (/loop-continue)", tone: "dim" },
    ]);
  });

  it("confirms the resume", () => {
    expect(formatLoopEvent({ type: "loop.resumed", iteration: 4 })).toEqual([
      { text: "  ▶ loop resumed at iteration 4", tone: "dim" },
    ]);
  });

  it("confirms applied guidance and singularizes one message", () => {
    expect(formatLoopEvent({ type: "loop.steered", iteration: 2, count: 1 })).toEqual([
      { text: "  ➤ loop applied 1 guidance message at iteration 2", tone: "dim" },
    ]);
    expect(formatLoopEvent({ type: "loop.steered", iteration: 2, count: 3 })[0]?.text).toContain(
      "applied 3 guidance messages",
    );
  });
});

describe("formatLoopEvent verification detail", () => {
  const stage = (overrides: Partial<LoopStageResult> = {}): LoopStageResult => ({
    id: "unit",
    command: "pnpm test",
    code: 0,
    output: "",
    attempts: 1,
    flaky: false,
    durationMs: 120,
    ...overrides,
  });

  it("marks a retry-only pass as flaky", () => {
    expect(formatLoopEvent({ type: "verify.flaky", iteration: 1, stageId: "unit", attempts: 3 })).toEqual([
      { text: "  ! loop · verifier unit passed after 3 attempts (flaky)", tone: "error" },
    ]);
  });

  it("renders a passing stage dim and a failing stage as an error", () => {
    expect(formatLoopEvent({ type: "verify.stage.completed", iteration: 1, result: stage() })).toEqual([
      { text: "  ✓ loop · verifier unit · 120ms", tone: "dim" },
    ]);
    expect(
      formatLoopEvent({ type: "verify.stage.completed", iteration: 1, result: stage({ code: 2, flaky: true }) }),
    ).toEqual([{ text: "  ✗ loop · verifier unit · 120ms · flaky", tone: "error" }]);
  });

  it("reports verification impact only when the pass is partial", () => {
    const allRun: LoopEvent = {
      type: "verify.impact",
      iteration: 1,
      changedPaths: [],
      decisions: [{ stageId: "unit", action: "run", reason: "full", matchedPaths: [] }],
      fullFallback: true,
    };
    expect(formatLoopEvent(allRun)).toEqual([]);
    const partial: LoopEvent = {
      type: "verify.impact",
      iteration: 1,
      changedPaths: ["src/a.ts"],
      decisions: [
        { stageId: "unit", action: "run", reason: "direct", matchedPaths: ["src/a.ts"] },
        { stageId: "e2e", action: "skip", reason: "unaffected", matchedPaths: [] },
      ],
      fullFallback: false,
    };
    expect(formatLoopEvent(partial)).toEqual([
      { text: "  loop · verification impact · 1 run, 0 reused, 1 skipped, 0 blocked", tone: "dim" },
    ]);
  });

  it("reports a stuck-loop recovery attempt", () => {
    expect(
      formatLoopEvent({
        type: "loop.recovery",
        iteration: 5,
        attempt: 2,
        reason: "cycle",
        category: "test",
        strategy: "reduce_scope",
      }),
    ).toEqual([{ text: "  ↻ loop · recovery 2 after cycle · test/reduce_scope", tone: "dim" }]);
  });
});

describe("loopStatusTone", () => {
  it("passed and cancelled are calm (dim)", () => {
    expect(loopStatusTone("passed")).toBe("dim");
    expect(loopStatusTone("cancelled")).toBe("dim");
  });

  it("every non-passing terminal status is an error", () => {
    for (const s of ["exhausted", "no_progress", "budget", "verify_error"] as const) {
      expect(loopStatusTone(s)).toBe("error");
    }
  });
});

describe("formatLoopEvent", () => {
  it("renders model escalation decisions", () => {
    expect(
      formatLoopEvent({
        type: "loop.model.routed",
        iteration: 2,
        category: "test",
        model: "strong",
        consecutiveFailures: 2,
        candidateIndex: 1,
        reason: "escalated_category",
      }),
    ).toEqual([{ text: "  loop · test → strong · streak 2 · escalated", tone: "dim" }]);
  });
  it("formats iteration.start as one dim line", () => {
    const e: LoopEvent = { type: "iteration.start", iteration: 2 };
    expect(formatLoopEvent(e)).toEqual([{ text: "⟳ loop · iteration 2", tone: "dim" }]);
  });

  it("formats run.completed with a 4-decimal cost", () => {
    const e: LoopEvent = { type: "run.completed", iteration: 1, costUsd: 0.0123 };
    expect(formatLoopEvent(e)).toEqual([{ text: "  loop · iteration 1 run complete · $0.0123", tone: "dim" }]);
  });

  it("formats live verification output as a bounded dim line", () => {
    const e: LoopEvent = { type: "verify.output", iteration: 1, stream: "stderr", chunk: "first\nboom\n" };
    expect(formatLoopEvent(e)).toEqual([{ text: "  ! boom", tone: "dim" }]);
  });

  it("does not split a surrogate pair in live verification output", () => {
    const e: LoopEvent = {
      type: "verify.output",
      iteration: 1,
      stream: "stdout",
      chunk: "😀".repeat(200),
    };
    const [notice] = formatLoopEvent(e);
    expect(notice?.text.endsWith("…")).toBe(true);
    const beforeEllipsis = notice?.text.charCodeAt((notice?.text.length ?? 0) - 2) ?? 0;
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it("formats a passing verify as a dim head plus an output tail", () => {
    const e: LoopEvent = { type: "verify", iteration: 1, code: 0, passed: true, output: "All good\n" };
    expect(formatLoopEvent(e)).toEqual([
      { text: "  ✓ loop · iteration 1 verify passed", tone: "dim" },
      { text: "    All good", tone: "dim" },
    ]);
  });

  it("formats a failing verify as an error head plus a dim tail", () => {
    const e: LoopEvent = {
      type: "verify",
      iteration: 3,
      code: 2,
      passed: false,
      output: "line1\nboom: it failed",
    };
    expect(formatLoopEvent(e)).toEqual([
      { text: "  ✗ loop · iteration 3 verify failed (exit 2)", tone: "error" },
      { text: "    boom: it failed", tone: "dim" },
    ]);
  });

  it("omits the tail line when verify output is empty", () => {
    const e: LoopEvent = { type: "verify", iteration: 1, code: 0, passed: true, output: "" };
    expect(formatLoopEvent(e)).toEqual([{ text: "  ✓ loop · iteration 1 verify passed", tone: "dim" }]);
  });

  it("delegates loop.done to the summary block", () => {
    const e: LoopEvent = { type: "loop.done", result: result({ status: "passed", iterations: 2, costUsd: 0.5 }) };
    expect(formatLoopEvent(e)).toEqual(formatLoopSummary(e.result));
  });
});

describe("formatLoopSummary", () => {
  it("shows a passing summary (dim) with iterations, cost, and a resume hint", () => {
    expect(formatLoopSummary(result({ status: "passed", iterations: 3, costUsd: 0.25, sessionId: "abc" }))).toEqual([
      { text: "⟳ loop done — passed", tone: "dim" },
      { text: "  iterations: 3 · cost: $0.2500", tone: "dim" },
      { text: "  session: abc (/resume abc to continue)", tone: "dim" },
    ]);
  });

  it("shows the persisted loop resume id", () => {
    const lines = formatLoopSummary(result({ loopId: "loop-abc" }));
    expect(lines.some((line) => line.text.includes("/loop-resume loop-abc"))).toBe(true);
  });

  it("shows the approval flag when confirm-mode requirements are pending", () => {
    const lines = formatLoopSummary(result({ status: "requirements_pending", loopId: "loop-abc" }));
    expect(lines.some((line) => line.text.includes("/loop-resume --approve-requirements loop-abc"))).toBe(true);
  });

  it("marks a budget-exhausted summary as an error", () => {
    const lines = formatLoopSummary(result({ status: "budget", iterations: 4, costUsd: 1 }));
    expect(lines[0]).toEqual({ text: "⟳ loop done — budget", tone: "error" });
  });

  it("marks a cancelled summary as calm (dim)", () => {
    const lines = formatLoopSummary(result({ status: "cancelled", iterations: 1 }));
    expect(lines[0]).toEqual({ text: "⟳ loop done — cancelled", tone: "dim" });
  });

  it("handles the zero-iteration (already green / never ran) summary", () => {
    const lines = formatLoopSummary(result({ status: "passed", iterations: 0, costUsd: 0, sessionId: "" }));
    // No sessionId → no resume hint line.
    expect(lines).toEqual([
      { text: "⟳ loop done — passed", tone: "dim" },
      { text: "  iterations: 0 · cost: $0.0000", tone: "dim" },
    ]);
  });

  it("marks a verify_error summary as an error", () => {
    const lines = formatLoopSummary(result({ status: "verify_error", iterations: 0, sessionId: "" }));
    expect(lines[0]?.tone).toBe("error");
  });
});
