import { describe, expect, it } from "vitest";
import {
  emptyLoopProgress,
  formatCost,
  loopRows,
  loopStatusTone,
  outputTail,
  reduceLoopEvent,
  type LoopProgress,
} from "./loop";
import type { LoopEvent } from "../types";

const feed = (events: LoopEvent[]): LoopProgress =>
  events.reduce(reduceLoopEvent, emptyLoopProgress());

describe("reduceLoopEvent", () => {
  it("appends every event in order", () => {
    const p = feed([
      { type: "iteration.start", iteration: 1 },
      { type: "run.completed", iteration: 1, costUsd: 0.01 },
    ]);
    expect(p.events).toHaveLength(2);
    expect(p.events[0]).toEqual({ type: "iteration.start", iteration: 1 });
    expect(p.result).toBeNull();
  });

  it("stashes the final result on loop.done", () => {
    const p = feed([
      { type: "iteration.start", iteration: 1 },
      {
        type: "loop.done",
        result: {
          status: "passed",
          iterations: 1,
          costUsd: 0.02,
          sessionId: "s1",
          finalVerify: { code: 0, output: "ok" },
        },
      },
    ]);
    expect(p.result?.status).toBe("passed");
    expect(p.result?.costUsd).toBe(0.02);
  });
});

describe("loopRows", () => {
  it("merges per-iteration events into ordered rows", () => {
    const rows = loopRows([
      { type: "iteration.start", iteration: 1 },
      { type: "run.completed", iteration: 1, costUsd: 0.004 },
      { type: "verify", iteration: 1, code: 1, passed: false, output: "line a\nFAIL line b" },
      { type: "iteration.start", iteration: 2 },
      { type: "run.completed", iteration: 2, costUsd: 0.005 },
      { type: "verify", iteration: 2, code: 0, passed: true, output: "PASS" },
      {
        type: "loop.done",
        result: { status: "passed", iterations: 2, costUsd: 0.009, sessionId: "s", finalVerify: { code: 0, output: "PASS" } },
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      iteration: 1,
      costUsd: 0.004,
      verify: { code: 1, passed: false, tail: "FAIL line b" },
      liveTail: "",
    });
    expect(rows[1]!.verify?.passed).toBe(true);
  });

  it("creates a row even when only iteration.start arrived", () => {
    const rows = loopRows([{ type: "iteration.start", iteration: 3 }]);
    expect(rows).toEqual([{ iteration: 3, costUsd: null, verify: null, liveTail: "" }]);
  });

  it("shows live verify output before the final result", () => {
    const rows = loopRows([
      { type: "verify.output", iteration: 1, stream: "stdout", chunk: "running test\ncase 3" },
    ]);
    expect(rows[0]?.liveTail).toBe("case 3");
  });
});

describe("live output bounds", () => {
  it("coalesces adjacent chunks and bounds retained events", () => {
    let progress = emptyLoopProgress();
    for (let i = 0; i < 700; i++) {
      progress = reduceLoopEvent(progress, {
        type: "verify.output",
        iteration: i,
        stream: "stdout",
        chunk: `line ${i}\n`,
      });
    }
    expect(progress.events.length).toBeLessThanOrEqual(500);
  });
});

describe("loopStatusTone", () => {
  it("maps statuses to tones", () => {
    expect(loopStatusTone("passed")).toBe("ok");
    expect(loopStatusTone("cancelled")).toBe("warn");
    expect(loopStatusTone("exhausted")).toBe("danger");
    expect(loopStatusTone("no_progress")).toBe("danger");
    expect(loopStatusTone("budget")).toBe("danger");
    expect(loopStatusTone("verify_error")).toBe("danger");
  });
});

describe("formatCost", () => {
  it("formats USD with 4 decimals", () => {
    expect(formatCost(0.0093)).toBe("$0.0093");
    expect(formatCost(0)).toBe("$0.0000");
  });
});

describe("outputTail", () => {
  it("returns the last non-empty line", () => {
    expect(outputTail("first\nlast\n\n")).toBe("last");
  });

  it("clips long lines with an ellipsis", () => {
    expect(outputTail("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
