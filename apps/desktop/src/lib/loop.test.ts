import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_DETAIL,
  MAX_ROW_STAGES,
  emptyLoopProgress,
  formatCost,
  loopHistoryDetail,
  loopRows,
  loopStatusTone,
  loopWarnings,
  outputTail,
  reduceLoopEvent,
  type LoopProgress,
} from "./loop";
import type { LoopEvent } from "../types";

const feed = (events: LoopEvent[]): LoopProgress => events.reduce(reduceLoopEvent, emptyLoopProgress());

describe("reduceLoopEvent", () => {
  it("retains persistence warnings for separate rendering", () => {
    const progress = reduceLoopEvent(emptyLoopProgress(), {
      type: "loop.warning",
      warning: "persistence",
      message: "read-only filesystem",
    });
    expect(loopWarnings(progress.events)).toEqual(["read-only filesystem"]);
  });

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
        result: {
          status: "passed",
          iterations: 2,
          costUsd: 0.009,
          sessionId: "s",
          finalVerify: { code: 0, output: "PASS" },
        },
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      iteration: 1,
      costUsd: 0.004,
      verify: { code: 1, passed: false, tail: "FAIL line b" },
      liveTail: "",
      tokens: null,
      durationMs: null,
      changedPaths: 0,
      failureCategory: null,
      stages: [],
      activeStage: null,
      flaky: [],
      impact: null,
      rollback: null,
    });
    expect(rows[1]!.verify?.passed).toBe(true);
  });

  it("creates a row even when only iteration.start arrived", () => {
    const rows = loopRows([{ type: "iteration.start", iteration: 3 }]);
    expect(rows).toEqual([
      {
        iteration: 3,
        costUsd: null,
        verify: null,
        liveTail: "",
        tokens: null,
        durationMs: null,
        changedPaths: 0,
        failureCategory: null,
        stages: [],
        activeStage: null,
        flaky: [],
        impact: null,
        rollback: null,
      },
    ]);
  });

  it("shows live verify output before the final result", () => {
    const rows = loopRows([{ type: "verify.output", iteration: 1, stream: "stdout", chunk: "running test\ncase 3" }]);
    expect(rows[0]?.liveTail).toBe("case 3");
  });

  /**
   * With a multi-stage plan the aggregate `verify` output is the concatenated
   * `[stageId] …` transcript and the row only keeps its LAST line, so the
   * failing stage is essentially never visible there. The per-stage rows are
   * what names it.
   */
  it("keeps a per-stage outcome so the failing verifier is identifiable", () => {
    const rows = loopRows([
      { type: "iteration.start", iteration: 1 },
      { type: "verify.stage.started", iteration: 1, stageId: "lint", attempt: 1 },
      {
        type: "verify.stage.completed",
        iteration: 1,
        result: { id: "lint", command: "pnpm lint", code: 0, output: "ok", attempts: 1, flaky: false, durationMs: 900 },
      },
      { type: "verify.stage.started", iteration: 1, stageId: "test", attempt: 1 },
      {
        type: "verify.stage.completed",
        iteration: 1,
        result: {
          id: "test",
          command: "pnpm test",
          code: 1,
          output: "…\nFAIL src/a.test.ts",
          attempts: 1,
          flaky: false,
          durationMs: 5_100,
        },
      },
      { type: "verify", iteration: 1, code: 1, passed: false, output: "[test] done" },
    ]);
    expect(rows[0]?.stages).toEqual([
      { id: "lint", code: 0, passed: true, attempts: 1, flaky: false, durationMs: 900, tail: "ok" },
      { id: "test", code: 1, passed: false, attempts: 1, flaky: false, durationMs: 5_100, tail: "FAIL src/a.test.ts" },
    ]);
    expect(rows[0]?.activeStage).toBeNull();
  });

  it("names the stage that is still running", () => {
    const rows = loopRows([
      { type: "iteration.start", iteration: 2 },
      { type: "verify.stage.started", iteration: 2, stageId: "typecheck", attempt: 1 },
    ]);
    expect(rows[0]?.activeStage).toBe("typecheck");
  });

  /** Desktop is the surface that offers the retry switch; a retried pass must not look clean. */
  it("surfaces a verifier that only passed after a retry", () => {
    const rows = loopRows([
      { type: "verify.flaky", iteration: 1, stageId: "test", attempts: 3 },
      {
        type: "verify.stage.completed",
        iteration: 1,
        result: { id: "test", command: "pnpm test", code: 0, output: "ok", attempts: 3, flaky: true, durationMs: 10 },
      },
    ]);
    expect(rows[0]?.flaky).toEqual([{ stageId: "test", attempts: 3 }]);
    expect(rows[0]?.stages[0]?.flaky).toBe(true);
  });

  it("records a rollback: it changed files in the user's workspace", () => {
    const rows = loopRows([
      { type: "iteration.start", iteration: 4 },
      { type: "loop.rollback", iteration: 4, restored: ["src/a.ts", "src/b.ts"], deleted: ["src/c.ts"] },
    ]);
    expect(rows[0]?.rollback).toEqual({ restored: 2, deleted: 1 });
  });

  it("counts impact-selection decisions", () => {
    const rows = loopRows([
      {
        type: "verify.impact",
        iteration: 1,
        changedPaths: ["src/a.ts"],
        decisions: [
          { stageId: "lint", action: "run", reason: "direct", matchedPaths: ["src/a.ts"] },
          { stageId: "test", action: "skip", reason: "unaffected", matchedPaths: [] },
          { stageId: "e2e", action: "reuse", reason: "cache_hit", matchedPaths: [] },
        ],
        fullFallback: false,
      },
    ]);
    expect(rows[0]?.impact).toEqual({ skipped: 1, reused: 1, blocked: 0, fullFallback: false });
  });

  it("bounds the stage and flaky lists it renders", () => {
    const events: LoopEvent[] = [];
    for (let i = 0; i < MAX_ROW_STAGES + 10; i++) {
      events.push({
        type: "verify.stage.completed",
        iteration: 1,
        result: { id: `stage-${i}`, command: "x", code: 0, output: "", attempts: 1, flaky: false, durationMs: 1 },
      });
      events.push({ type: "verify.flaky", iteration: 1, stageId: `stage-${i}`, attempts: 2 });
    }
    const rows = loopRows(events);
    expect(rows[0]?.stages).toHaveLength(MAX_ROW_STAGES);
    expect(rows[0]?.flaky).toHaveLength(MAX_ROW_STAGES);
  });
});

describe("loopHistoryDetail", () => {
  it("renders what a persisted event actually said, not just its type", () => {
    expect(loopHistoryDetail({ type: "verify", iteration: 2, code: 1, passed: false, output: "a\nFAIL b" })).toBe(
      "#2 · exit 1 · FAIL b",
    );
    expect(loopHistoryDetail({ type: "loop.warning", warning: "persistence", message: "read-only filesystem" })).toBe(
      "persistence · read-only filesystem",
    );
    expect(loopHistoryDetail({ type: "verify.flaky", iteration: 3, stageId: "test", attempts: 2 })).toBe(
      "#3 · test · 2 attempts",
    );
    expect(loopHistoryDetail({ type: "loop.rollback", iteration: 5, restored: ["a", "b"], deleted: [] })).toBe(
      "#5 · 2 restored · 0 deleted",
    );
  });

  it("clips a long detail instead of pushing the whole output into the log", () => {
    const detail = loopHistoryDetail({ type: "loop.warning", warning: "observer", message: "x".repeat(500) });
    expect(detail.length).toBeLessThanOrEqual(MAX_HISTORY_DETAIL);
  });

  /** History is transport data typed only as `{ type: string }`: never crash, never drop the row. */
  it("degrades to an empty detail for unknown or malformed events", () => {
    expect(loopHistoryDetail({ type: "future.event", whatever: 1 })).toBe("");
    expect(loopHistoryDetail({ type: "verify.stage.completed", result: null })).toBe("exit ?");
    expect(loopHistoryDetail({ type: "loop.done", result: "nope" })).toBe("? iteration(s)");
    expect(loopHistoryDetail({ type: "run.completed", iteration: Number.NaN, costUsd: "free" })).toBe("");
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

  it("retains requirement state after its source events are evicted", () => {
    const spec = {
      version: 1 as const,
      goal: "ship it",
      deliverables: ["implementation"],
      requirements: [{ id: "REQ-1", text: "implement it", required: true }],
      constraints: [],
      outOfScope: [],
      assumptions: [],
      acceptanceCriteria: [{ id: "AC-1", text: "it works", requirementIds: ["REQ-1"] }],
      unresolvedQuestions: [],
    };
    let progress = reduceLoopEvent(emptyLoopProgress(), {
      type: "requirements.completed",
      spec,
      approvalRequired: false,
    });
    progress = reduceLoopEvent(progress, {
      type: "requirements.reviewed",
      review: { complete: false, criteria: [{ id: "AC-1", status: "unmet", evidence: [] }], gaps: ["missing"] },
    });
    for (let i = 0; i < 600; i++) {
      progress = reduceLoopEvent(progress, { type: "iteration.start", iteration: i });
    }
    expect(progress.events.some((event) => event.type === "requirements.completed")).toBe(false);
    expect(progress.requirements).toEqual(spec);
    expect(progress.acceptanceReview?.gaps).toEqual(["missing"]);
  });
});

describe("loopStatusTone", () => {
  it("maps statuses to tones", () => {
    expect(loopStatusTone("passed")).toBe("ok");
    expect(loopStatusTone("cancelled")).toBe("warn");
    // A pause awaiting requirement approval is not a failure — warn, not danger.
    expect(loopStatusTone("requirements_pending")).toBe("warn");
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
