/**
 * WS loop mode (/ws `loop` frame) — drives the core auto-loop and streams its
 * progress as `loop.event` frames, ending with `idle`. Mirrors ws.test.ts:
 * the loop runner is faked so no real model/verify calls happen.
 */
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { LoopOptions, LoopResult } from "@seekforge/core";
import {
  startServer,
  type CreateAgentFn,
  type ResumeLoopFn,
  type RunLoopFn,
  type RunningServer,
} from "../src/index.js";
import {
  collectFrames,
  connectWs,
  fakeAgentFactory,
  fakeLoopFactory,
  makeWorkspace,
  unusedAgentFactory,
  unusedLoopFactory,
  unusedResumeLoopFactory,
  waitUntil,
  type FrameCollector,
} from "./helpers.js";

const TOKEN = "test-token-loop";

let server: RunningServer | undefined;
const sockets: WebSocket[] = [];

async function boot(
  opts: { createAgent?: CreateAgentFn; runLoop?: RunLoopFn; resumeLoop?: ResumeLoopFn },
  workspace = makeWorkspace(),
) {
  server = await startServer({
    workspace,
    port: 0,
    token: TOKEN,
    createAgent: opts.createAgent ?? unusedAgentFactory,
    runLoop: opts.runLoop ?? unusedLoopFactory,
    resumeLoop: opts.resumeLoop ?? unusedResumeLoopFactory,
  });
  return { server, workspace };
}

async function open(port: number): Promise<{ ws: WebSocket; rx: FrameCollector }> {
  const ws = await connectWs(port, TOKEN);
  sockets.push(ws);
  return { ws, rx: collectFrames(ws) };
}

function sendFrame(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

function loopResult(overrides: Partial<LoopResult> = {}): LoopResult {
  return {
    status: "passed",
    iterations: 1,
    costUsd: 0,
    sessionId: "loop-1",
    finalVerify: { code: 0, output: "" },
    ...overrides,
  };
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = undefined;
});

describe("loop.resume", () => {
  it("validates and routes additive limits while streaming events", async () => {
    let seen: Parameters<ResumeLoopFn>[2] | undefined;
    let seenId = "";
    const { server, workspace } = await boot({
      resumeLoop: async (_agentOpts, loopId, opts) => {
        seenId = loopId;
        seen = opts;
        const result = loopResult({ loopId, iterations: 4 });
        opts.onEvent?.({ type: "iteration.start", iteration: 4 });
        opts.onEvent?.({ type: "loop.done", result });
        return result;
      },
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, {
      type: "loop.resume",
      loopId: "loop-abc",
      addedIterations: 3,
      addedBudget: 0.75,
      addedTokenBudget: 2_000,
      addedDurationMs: 30_000,
      addedVerifyRuns: 2,
      approveRequirements: true,
    });
    await rx.waitFor((f) => f.type === "loop.event");
    await rx.waitFor((f) => f.type === "idle");
    expect(seenId).toBe("loop-abc");
    expect(seen).toMatchObject({
      workspace,
      additionalIterations: 3,
      additionalCostBudgetUsd: 0.75,
      additionalTokenBudget: 2_000,
      additionalDurationMs: 30_000,
      additionalVerifyRuns: 2,
      approveRequirements: true,
      approvalMode: "acceptEdits",
    });
  });

  it("rejects unsafe ids and invalid additive limits", async () => {
    const { server } = await boot({});
    const { ws, rx } = await open(server.port);
    for (const frame of [
      { type: "loop.resume", loopId: "../loop" },
      { type: "loop.resume", loopId: "loop with spaces" },
      { type: "loop.resume", loopId: "loop-1", addedIterations: 0 },
      { type: "loop.resume", loopId: "loop-1", addedIterations: 1.5 },
      { type: "loop.resume", loopId: "loop-1", addedBudget: Number.POSITIVE_INFINITY },
      { type: "loop.resume", loopId: "loop-1", approveRequirements: "yes" },
    ]) {
      sendFrame(ws, frame);
      expect((await rx.waitFor((f) => f.type === "error")).code).toBe("bad_frame");
    }
  });

  it("reports a resume failure and accepts omitted additive options", async () => {
    const { server } = await boot({
      resumeLoop: async () => {
        throw "resume unavailable";
      },
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "loop.resume", loopId: "loop-failed" });
    const error = await rx.waitFor((frame) => frame.type === "error");
    expect(error).toMatchObject({ code: "loop_error", message: "resume unavailable" });
    await rx.waitFor((frame) => frame.type === "idle");
  });
});

describe("loop -> loop.event -> idle", () => {
  it("streams loop.event frames (incl. loop.done) then idle", async () => {
    let seen: LoopOptions | undefined;
    const { server, workspace } = await boot({
      runLoop: fakeLoopFactory(async (_opts, loopOpts) => {
        seen = loopOpts;
        const result = loopResult();
        loopOpts.onEvent?.({ type: "iteration.start", iteration: 1 });
        loopOpts.onEvent?.({ type: "verify.output", iteration: 1, stream: "stdout", chunk: "running\n" });
        loopOpts.onEvent?.({ type: "verify", iteration: 1, code: 0, passed: true, output: "ok" });
        loopOpts.onEvent?.({ type: "loop.done", result });
        return result;
      }),
    });
    const { ws, rx } = await open(server.port);

    sendFrame(ws, {
      type: "loop",
      task: "make it green",
      verifyCommand: "pnpm test",
      maxIterations: 4,
      budget: 1.5,
      tokenBudget: 20_000,
      maxDurationMs: 60_000,
      maxVerifyRuns: 6,
      verifyTimeoutMs: 10_000,
      agentTimeoutMs: 30_000,
      maxAgentRetries: 0,
      requirementMode: "analyze",
    });

    const start = await rx.waitFor(
      (f) => f.type === "loop.event" && (f.event as { type: string }).type === "iteration.start",
    );
    expect(start.event).toMatchObject({ type: "iteration.start", iteration: 1 });
    const output = await rx.waitFor(
      (f) => f.type === "loop.event" && (f.event as { type: string }).type === "verify.output",
    );
    expect(output.event).toMatchObject({ type: "verify.output", stream: "stdout", chunk: "running\n" });
    await rx.waitFor((f) => f.type === "loop.event" && (f.event as { type: string }).type === "verify");
    const done = await rx.waitFor((f) => f.type === "loop.event" && (f.event as { type: string }).type === "loop.done");
    expect(done.event).toMatchObject({ type: "loop.done", result: { status: "passed" } });
    await rx.waitFor((f) => f.type === "idle");

    // The loop frame fields are mapped onto the core LoopOptions exactly.
    expect(seen).toMatchObject({
      workspace,
      task: "make it green",
      verifyCommand: "pnpm test",
      maxIterations: 4,
      costBudgetUsd: 1.5,
      tokenBudget: 20_000,
      maxDurationMs: 60_000,
      maxVerifyRuns: 6,
      verifyTimeoutMs: 10_000,
      agentTimeoutMs: 30_000,
      maxAgentRetries: 0,
      requirementMode: "analyze",
      approvalMode: "acceptEdits",
    });
  });

  it("threads model/thinking overrides onto the agent options", async () => {
    let seenAgent: { overrides?: unknown } | undefined;
    const { server } = await boot({
      runLoop: fakeLoopFactory(async (agentOpts, loopOpts) => {
        seenAgent = agentOpts as { overrides?: unknown };
        const result = loopResult();
        loopOpts.onEvent?.({ type: "loop.done", result });
        return result;
      }),
    });
    const { ws, rx } = await open(server.port);

    sendFrame(ws, {
      type: "loop",
      task: "go",
      verifyCommand: "x",
      model: "deepseek-v4-pro",
      thinking: true,
      reasoningEffort: "max",
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(seenAgent?.overrides).toEqual({ model: "deepseek-v4-pro", thinking: true, reasoningEffort: "max" });
  });

  it("validates task, verifyCommand, and numeric limits", async () => {
    const { server } = await boot({ runLoop: unusedLoopFactory });
    const { ws, rx } = await open(server.port);

    const expectBadFrame = async (frame: unknown) => {
      sendFrame(ws, frame);
      const err = await rx.waitFor((f) => f.type === "error");
      expect(err.code).toBe("bad_frame");
    };

    await expectBadFrame({ type: "loop", task: "", verifyCommand: "pnpm test" });
    await expectBadFrame({ type: "loop", task: "   ", verifyCommand: "pnpm test" });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "" });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "   " });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", maxIterations: "nope" });
    // Non-positive / non-integer limits are rejected at the protocol entry.
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", maxIterations: 0 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", maxIterations: -3 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", maxIterations: 1.5 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", maxIterations: 101 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", budget: 0 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", budget: -1 });
    await expectBadFrame({ type: "loop", task: "go", verifyCommand: "x", requirementMode: "analysis" });

    sendFrame(ws, { type: "loop", task: "go", verifyCommand: "x", ws: "unknown-ws" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_workspace");
  });

  it("records confirm requirements as waiting instead of failed", async () => {
    const { server } = await boot({
      runLoop: fakeLoopFactory(async (_agentOpts, loopOpts) => {
        const result = loopResult({ status: "requirements_pending", loopId: "loop-wait", iterations: 0 });
        loopOpts.onEvent?.({ type: "loop.done", result });
        return result;
      }),
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "loop", task: "go", verifyCommand: "x", requirementMode: "confirm" });
    const accepted = await rx.waitFor((frame) => frame.type === "run.accepted");
    await rx.waitFor((frame) => frame.type === "idle");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runs/${accepted.runId}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const record = (await response.json()) as { status: string; sessionId?: string; error?: unknown };
    expect(record).toMatchObject({
      status: "waiting",
      sessionId: "loop-1",
    });
    expect(record.error).toBeUndefined();
  });

  it("records an unexpected loop exception and releases the connection", async () => {
    const { server } = await boot({
      runLoop: async () => {
        throw new Error("verifier exploded");
      },
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "loop", task: "go", verifyCommand: "x" });
    const error = await rx.waitFor((frame) => frame.type === "error");
    expect(error).toMatchObject({ code: "loop_error", message: "verifier exploded" });
    await rx.waitFor((frame) => frame.type === "idle");

    sendFrame(ws, { type: "loop", task: "retry", verifyCommand: "x" });
    expect((await rx.waitFor((frame) => frame.type === "error")).code).toBe("loop_error");
  });
});

describe("loop busy rule", () => {
  it("rejects a second loop or start while a loop is running", async () => {
    let release: (() => void) | undefined;
    const { server } = await boot({
      createAgent: fakeAgentFactory(async function* () {}),
      runLoop: fakeLoopFactory(async (_opts, loopOpts) => {
        loopOpts.onEvent?.({ type: "iteration.start", iteration: 1 });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        const result = loopResult();
        loopOpts.onEvent?.({ type: "loop.done", result });
        return result;
      }),
    });
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "loop", task: "go", verifyCommand: "x" });
    await rx.waitFor((f) => f.type === "loop.event" && (f.event as { type: string }).type === "iteration.start");

    sendFrame(ws, { type: "loop", task: "again", verifyCommand: "x" });
    let busy = await rx.waitFor((f) => f.type === "error");
    expect(busy.code).toBe("busy");

    sendFrame(ws, { type: "start", task: "x", mode: "edit", approvalMode: "auto" });
    busy = await rx.waitFor((f) => f.type === "error");
    expect(busy.code).toBe("busy");

    release?.();
    await rx.waitFor((f) => f.type === "idle");
  });
});

describe("loop cancel", () => {
  it("aborts the running loop via the AbortSignal", async () => {
    let abortedSeen = false;
    const { server } = await boot({
      runLoop: fakeLoopFactory(async (_opts, loopOpts) => {
        loopOpts.onEvent?.({ type: "iteration.start", iteration: 1 });
        await new Promise<void>((resolve) => {
          if (loopOpts.signal?.aborted) return resolve();
          loopOpts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        abortedSeen = loopOpts.signal?.aborted ?? false;
        const result = loopResult({ status: "cancelled" });
        loopOpts.onEvent?.({ type: "loop.done", result });
        return result;
      }),
    });
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "loop", task: "long job", verifyCommand: "x" });
    await rx.waitFor((f) => f.type === "loop.event" && (f.event as { type: string }).type === "iteration.start");

    sendFrame(ws, { type: "cancel" });
    const done = await rx.waitFor((f) => f.type === "loop.event" && (f.event as { type: string }).type === "loop.done");
    expect(done.event).toMatchObject({ type: "loop.done", result: { status: "cancelled" } });
    await rx.waitFor((f) => f.type === "idle");
    await waitUntil(() => abortedSeen);
    expect(abortedSeen).toBe(true);
  });

  it("classifies an exception raised after abort as cancelled", async () => {
    let entered = false;
    const { server } = await boot({
      runLoop: async (_opts, loopOpts) => {
        entered = true;
        await new Promise<void>((resolve) => {
          if (loopOpts.signal?.aborted) resolve();
          else loopOpts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("provider aborted");
      },
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "loop", task: "long job", verifyCommand: "x" });
    await rx.waitFor((frame) => frame.type === "run.accepted");
    await waitUntil(() => entered);
    sendFrame(ws, { type: "cancel" });
    const error = await rx.waitFor((frame) => frame.type === "error");
    expect(error).toMatchObject({ code: "cancelled", message: "provider aborted" });
    await rx.waitFor((frame) => frame.type === "idle");
  });
});
