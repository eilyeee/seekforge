import { describe, expect, it } from "vitest";
import { decodeClientFrame, parseClientFrame } from "../src/ws-protocol.js";

const limits = { maxLoopIterations: 100, maxSteerMessageLength: 4_000 };

const validFrames = [
  { type: "start", task: "fix it", mode: "edit", approvalMode: "confirm", plan: false, ws: "main" },
  { type: "send", sessionId: "session-1", task: "continue", thinking: true },
  {
    type: "loop",
    task: "fix",
    verifyCommand: "pnpm test",
    maxIterations: 3,
    budget: 2.5,
    tokenBudget: 10_000,
    maxDurationMs: 60_000,
    maxVerifyRuns: 5,
    verifyTimeoutMs: 10_000,
    agentTimeoutMs: 30_000,
    maxAgentRetries: 0,
    verificationPlan: [
      { id: "types", command: "pnpm typecheck" },
      { id: "lint", command: "pnpm lint", required: false, timeoutMs: 20_000 },
    ],
    stablePasses: 2,
    flakyRetries: 1,
    maxNoProgressRecoveries: 1,
    rollbackOnRegression: false,
  },
  {
    type: "loop.resume",
    loopId: "loop_1",
    addedIterations: 2,
    addedTokenBudget: 5_000,
    addedDurationMs: 30_000,
    addedVerifyRuns: 2,
    approveRequirements: true,
  },
  { type: "permission.response", requestId: "p1", approved: true, selectedHunks: [0, 2] },
  { type: "question.answer", id: "q1", answer: "yes" },
  { type: "subagent.cancel", dispatchId: "ag-1" },
  { type: "subagent.steer", dispatchId: "ag-2", message: "focus on tests" },
  { type: "loop.pause" },
  { type: "loop.control.resume" },
  { type: "loop.steer", message: "focus on the parser" },
  { type: "subscribe", runId: "run-abc-123", afterSeq: 0 },
  { type: "cancel" },
] as const;

const invalidFrames = [
  null,
  [],
  { task: "missing type" },
  { type: "start", task: "", mode: "edit", approvalMode: "auto" },
  { type: "send", sessionId: 1, task: "continue" },
  { type: "loop", task: "fix", verifyCommand: "test", maxIterations: 101 },
  { type: "loop", task: "fix", verifyCommand: "test", tokenBudget: 0 },
  { type: "loop", task: "fix", verifyCommand: "test", maxAgentRetries: -1 },
  { type: "loop", task: "fix", verifyCommand: "test", stablePasses: 6 },
  { type: "loop", task: "fix", verifyCommand: "test", verificationPlan: [{ id: "../bad", command: "test" }] },
  { type: "loop", task: "fix", verifyCommand: "test", verificationPlan: [{ id: "test", command: "" }] },
  { type: "loop.resume", loopId: "../escape" },
  { type: "loop.resume", loopId: "loop-1", addedDurationMs: 0 },
  { type: "permission.response", requestId: "p1", approved: "yes" },
  { type: "question.answer", id: "q1", answer: 42 },
  { type: "subagent.cancel", dispatchId: "../ag-1" },
  { type: "subagent.steer", dispatchId: "ag-1", message: "" },
  { type: "loop.steer", message: "" },
  { type: "subscribe", runId: "../run-1" },
  { type: "unknown" },
] as const;

describe("WS client protocol decoder", () => {
  it.each(validFrames)("accepts $type", (frame) => {
    expect(parseClientFrame(frame, limits)).toMatchObject({ ok: true, frame });
  });

  it.each(invalidFrames)("rejects malformed input %#", (frame) => {
    expect(parseClientFrame(frame, limits)).toMatchObject({ ok: false });
  });

  it("decodes JSON and rejects invalid JSON", () => {
    expect(decodeClientFrame(JSON.stringify(validFrames[0]), limits)).toMatchObject({ ok: true });
    expect(decodeClientFrame("not json", limits)).toEqual({
      ok: false,
      error: "frames must be JSON objects with a type field",
    });
  });

  it("rejects every malformed optional override", () => {
    for (const override of [
      { model: "" },
      { thinking: "yes" },
      { reasoningEffort: "low" },
      { outputStyle: "" },
      { sandbox: "unrestricted" },
      { ws: 7 },
    ]) {
      expect(
        parseClientFrame({ type: "start", task: "go", mode: "ask", approvalMode: "confirm", ...override }, limits),
      ).toMatchObject({ ok: false });
    }
  });

  it("returns the request id when malformed selectedHunks must fail closed", () => {
    expect(
      parseClientFrame(
        { type: "permission.response", requestId: "p7", approved: true, selectedHunks: [0, -1] },
        limits,
      ),
    ).toEqual({
      ok: false,
      error: "permission.response.selectedHunks must contain 1-10000 non-negative safe integers",
      permissionRequestId: "p7",
    });
  });

  it("enforces caller-provided loop and steering limits", () => {
    expect(
      parseClientFrame(
        { type: "loop", task: "fix", verifyCommand: "test", maxIterations: 4 },
        { ...limits, maxLoopIterations: 3 },
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseClientFrame(
        { type: "subagent.steer", dispatchId: "ag-1", message: "four" },
        { ...limits, maxSteerMessageLength: 3 },
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseClientFrame({ type: "loop.steer", message: "four" }, { ...limits, maxSteerMessageLength: 3 }),
    ).toMatchObject({ ok: false });
  });
});
