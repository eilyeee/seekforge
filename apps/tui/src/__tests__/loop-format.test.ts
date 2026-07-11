import { describe, expect, it } from "vitest";
import type { LoopEvent, LoopResult } from "@seekforge/core";
import {
  formatLoopEvent,
  formatLoopSummary,
  loopOutputTail,
  loopStatusTone,
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
  it("formats iteration.start as one dim line", () => {
    const e: LoopEvent = { type: "iteration.start", iteration: 2 };
    expect(formatLoopEvent(e)).toEqual([{ text: "⟳ loop · iteration 2", tone: "dim" }]);
  });

  it("formats run.completed with a 4-decimal cost", () => {
    const e: LoopEvent = { type: "run.completed", iteration: 1, costUsd: 0.0123 };
    expect(formatLoopEvent(e)).toEqual([
      { text: "  loop · iteration 1 run complete · $0.0123", tone: "dim" },
    ]);
  });

  it("formats live verification output as a bounded dim line", () => {
    const e: LoopEvent = { type: "verify.output", iteration: 1, stream: "stderr", chunk: "first\nboom\n" };
    expect(formatLoopEvent(e)).toEqual([{ text: "  ! boom", tone: "dim" }]);
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
    expect(lines.some((line) => line.text.includes("seekforge loop-resume loop-abc"))).toBe(true);
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
