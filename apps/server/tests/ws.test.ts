import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { RunAgentTaskInput } from "@seekforge/core";
import type { ConfirmResult } from "@seekforge/shared";
import { MAX_WS_PAYLOAD_BYTES, startServer, type CreateAgentFn, type RunningServer } from "../src/index.js";
import {
  collectFrames,
  connectWs,
  emptyReport,
  fakeAgentFactory,
  makeWorkspace,
  recordingAgentFactory,
  waitUntil,
  writeFileIn,
  type FrameCollector,
} from "./helpers.js";

const TOKEN = "test-token-ws";

let server: RunningServer | undefined;
const sockets: WebSocket[] = [];

async function boot(createAgent: CreateAgentFn, workspace = makeWorkspace()) {
  server = await startServer({ workspace, port: 0, token: TOKEN, createAgent });
  return { server, workspace };
}

async function open(port: number, token = TOKEN): Promise<{ ws: WebSocket; rx: FrameCollector }> {
  const ws = await connectWs(port, token);
  sockets.push(ws);
  return { ws, rx: collectFrames(ws) };
}

function sendFrame(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await server?.close();
  server = undefined;
});

describe("WS auth", () => {
  it("rejects the upgrade without a valid token", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    await expect(connectWs(server.port, "wrong")).rejects.toThrow(/401/);
  });

  it("closes authenticated connections that exceed the inbound frame limit", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const ws = await connectWs(server.port, TOKEN);
    sockets.push(ws);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(Buffer.alloc(MAX_WS_PAYLOAD_BYTES + 1));
    await expect(closed).resolves.toBe(1009);
  });

  it("rejects binary payloads even when they contain valid JSON bytes", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);

    ws.send(Buffer.from(JSON.stringify({ type: "cancel" })));

    const error = await rx.waitFor((frame) => frame.type === "error");
    expect(error).toMatchObject({ code: "bad_frame", message: expect.stringContaining("not binary") });
  });
});

describe("start -> events -> idle", () => {
  it("serializes edit runs from separate connections targeting the same workspace", async () => {
    let active = 0;
    let maxActive = 0;
    let started = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { server } = await boot(
      fakeAgentFactory(async function* () {
        const invocation = ++started;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          yield { type: "session.created", sessionId: `serialized-${invocation}` };
          if (invocation === 1) await firstGate;
          yield { type: "session.completed", report: emptyReport() };
        } finally {
          active -= 1;
        }
      }),
    );
    const first = await open(server.port);
    const second = await open(server.port);

    sendFrame(first.ws, { type: "start", task: "first edit", mode: "edit", approvalMode: "auto" });
    await first.rx.waitFor((f) => f.type === "event" && (f.event as { type: string }).type === "session.created");
    sendFrame(second.ws, { type: "start", task: "second edit", mode: "edit", approvalMode: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(started).toBe(1);
    expect(maxActive).toBe(1);

    releaseFirst();
    await first.rx.waitFor((f) => f.type === "idle");
    await second.rx.waitFor((f) => f.type === "idle");
    expect(started).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("serializes edit runs across independent server instances", async () => {
    const workspace = makeWorkspace();
    let started = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const factory = fakeAgentFactory(async function* () {
      const invocation = ++started;
      yield { type: "session.created", sessionId: `cross-server-${invocation}` };
      if (invocation === 1) await firstGate;
      yield { type: "session.completed", report: emptyReport() };
    });
    const primary = await boot(factory, workspace);
    const peer = await startServer({ workspace, port: 0, token: TOKEN, createAgent: factory });
    let released = false;
    try {
      const first = await open(primary.server.port);
      const second = await open(peer.port);
      sendFrame(first.ws, { type: "start", task: "first", mode: "edit", approvalMode: "auto" });
      await first.rx.waitFor((frame) => frame.type === "event");
      sendFrame(second.ws, { type: "start", task: "second", mode: "edit", approvalMode: "auto" });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(started).toBe(1);

      released = true;
      releaseFirst();
      await first.rx.waitFor((frame) => frame.type === "idle");
      await second.rx.waitFor((frame) => frame.type === "idle");
      expect(started).toBe(2);
    } finally {
      if (!released) releaseFirst();
      await peer.close();
    }
  });

  it("streams scripted events (incl. model.delta) and finishes with idle", async () => {
    let seenInput: Record<string, unknown> = {};
    const { server, workspace } = await boot(
      fakeAgentFactory(async function* (opts, input) {
        seenInput = {
          projectPath: input.projectPath,
          mode: input.mode,
          approvalMode: input.approvalMode,
          task: input.task,
        };
        yield { type: "session.created", sessionId: "fake-1" };
        opts.onModelDelta?.("hel");
        opts.onModelDelta?.("lo");
        yield { type: "model.message", content: "hello" };
        yield { type: "session.completed", report: emptyReport("hello") };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "say hello", mode: "edit", approvalMode: "auto" });

    const created = await rx.waitFor((f) => f.type === "event");
    expect(created).toMatchObject({
      type: "event",
      sessionId: "fake-1",
      event: { type: "session.created", sessionId: "fake-1" },
    });
    // Deltas are coalesced server-side: "hel" + "lo" arrive as ONE model.delta
    // frame whose chunk is the concatenation (flushed before model.message).
    await rx.waitFor((f) => f.type === "event" && (f.event as { type: string; chunk?: string }).chunk === "hello");
    await rx.waitFor((f) => f.type === "event" && (f.event as { type: string }).type === "model.message");
    const completed = await rx.waitFor(
      (f) => f.type === "event" && (f.event as { type: string }).type === "session.completed",
    );
    expect(completed.sessionId).toBe("fake-1");
    await rx.waitFor((f) => f.type === "idle");

    expect(seenInput).toEqual({
      projectPath: workspace,
      mode: "edit",
      approvalMode: "auto",
      task: "say hello",
    });

    // The model.delta frames are server-level events carrying the session id.
    const delta = rx.frames.find((f) => f.type === "event" && (f.event as { type: string }).type === "model.delta");
    expect(delta).toMatchObject({ sessionId: "fake-1", event: { type: "model.delta", chunk: "hello" } });
  });

  it("send resumes an existing session with its original mode", async () => {
    let seenInput: Record<string, unknown> = {};
    const workspace = makeWorkspace();
    writeFileIn(
      workspace,
      ".seekforge/sessions/s1/session.json",
      JSON.stringify({
        id: "s1",
        task: "orig",
        mode: "ask",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { server } = await boot(
      fakeAgentFactory(async function* (_opts, input) {
        seenInput = { resumeSessionId: input.resumeSessionId, mode: input.mode, task: input.task };
        yield { type: "session.created", sessionId: "s1" };
        yield { type: "session.completed", report: emptyReport() };
      }),
      workspace,
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "send", sessionId: "missing", task: "go on" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_session");

    sendFrame(ws, { type: "send", sessionId: "s1", task: "go on" });
    await rx.waitFor((f) => f.type === "idle");
    expect(seenInput).toEqual({ resumeSessionId: "s1", mode: "ask", task: "go on" });
  });

  it("releases connection state when agent disposal throws", async () => {
    let runs = 0;
    const { server } = await boot(() => ({
      agent: {
        runTask: async function* () {
          runs += 1;
          yield { type: "session.created" as const, sessionId: `dispose-${runs}` };
          yield { type: "session.completed" as const, report: emptyReport() };
        },
      },
      dispose: () => {
        throw new Error("dispose failed");
      },
    }));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "first", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");
    sendFrame(ws, { type: "start", task: "second", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event" && (f.event as { sessionId?: string }).sessionId === "dispose-2");
    await rx.waitFor((f) => f.type === "idle" && runs === 2);

    expect(rx.frames.some((f) => f.type === "error" && f.code === "busy")).toBe(false);
  });
});

describe("subagent controls", () => {
  it("binds steer/cancel to the active run and fails closed for invalid dispatches", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let takeSteering: (() => string[]) | undefined;
    let manager: NonNullable<Parameters<CreateAgentFn>[0]["dispatchManager"]> | undefined;
    const { server } = await boot((opts) => {
      manager = opts.dispatchManager;
      manager!.start({
        agentId: "worker",
        task: "inspect",
        run: async (signal, hooks) => {
          takeSteering = hooks.takeSteering;
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
          });
          return { ok: false, error: { code: "aborted", message: "aborted" } };
        },
      });
      return {
        agent: {
          runTask: async function* () {
            yield { type: "session.created" as const, sessionId: "sub-controls" };
            await runGate;
            yield { type: "session.completed" as const, report: emptyReport() };
          },
        },
        dispose: () => {},
      };
    });
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "start", task: "run", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event");

    sendFrame(ws, { type: "subagent.steer", dispatchId: "ag-1", message: "focus", extra: true });
    expect((await rx.waitFor((f) => f.type === "error")).code).toBe("bad_frame");
    sendFrame(ws, { type: "subagent.steer", dispatchId: "ag-99", message: "focus" });
    expect((await rx.waitFor((f) => f.type === "error")).code).toBe("unknown_dispatch");

    sendFrame(ws, { type: "subagent.steer", dispatchId: "ag-1", message: "focus on parser tests" });
    expect(await rx.waitFor((f) => f.type === "subagent.control")).toEqual({
      type: "subagent.control",
      dispatchId: "ag-1",
      operation: "steer",
      status: "accepted",
    });
    let guidance: string[] = [];
    await waitUntil(() => {
      guidance = takeSteering?.() ?? [];
      return guidance.length > 0;
    });
    expect(guidance).toEqual(["focus on parser tests"]);

    sendFrame(ws, { type: "subagent.cancel", dispatchId: "ag-1" });
    expect(await rx.waitFor((f) => f.type === "subagent.control")).toEqual({
      type: "subagent.control",
      dispatchId: "ag-1",
      operation: "cancel",
      status: "accepted",
    });
    await waitUntil(() => manager?.get("ag-1")?.status === "cancelled");
    expect(manager?.get("ag-1")?.status).toBe("cancelled");

    releaseRun();
    await rx.waitFor((f) => f.type === "idle");
    sendFrame(ws, { type: "subagent.cancel", dispatchId: "ag-1" });
    expect((await rx.waitFor((f) => f.type === "error")).code).toBe("not_running");
  });

  it("rejects malformed subagent frames before consulting run state", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);
    const frames = [
      { type: "subagent.cancel", dispatchId: "../ag-1" },
      { type: "subagent.steer", dispatchId: "ag-1", message: "" },
      { type: "subagent.steer", dispatchId: "ag-1", message: 42 },
    ];
    for (const frame of frames) {
      sendFrame(ws, frame);
      expect((await rx.waitFor((f) => f.type === "error")).code).toBe("bad_frame");
    }
  });
});

describe("server shutdown", () => {
  it("aborts and awaits active WebSocket run cleanup before close resolves", async () => {
    let cleanupStarted = false;
    let disposed = false;
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const { server } = await boot(() => ({
      agent: {
        runTask: async function* (input) {
          try {
            yield { type: "session.created" as const, sessionId: "shutdown-ws" };
            await new Promise<void>((resolve) => {
              const done = () => resolve();
              input.signal?.addEventListener("abort", done, { once: true });
              if (input.signal?.aborted) done();
            });
          } finally {
            cleanupStarted = true;
            await cleanupGate;
          }
        },
      },
      dispose: () => {
        disposed = true;
      },
    }));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "start", task: "wait", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event");

    let resolved = false;
    const closing = server.close().then(() => {
      resolved = true;
    });
    try {
      await waitUntil(() => cleanupStarted);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(resolved).toBe(false);
      expect(disposed).toBe(false);
    } finally {
      releaseCleanup();
    }
    await closing;
    expect(disposed).toBe(true);
  });
});

describe("reasoning + new event forwarding", () => {
  it("streams reasoning.delta frames and forwards command.output / context.microcompacted unchanged", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "think-1" };
        opts.onReasoningDelta?.("hmm ");
        opts.onReasoningDelta?.("ok");
        opts.onModelDelta?.("answer");
        yield { type: "command.output", stream: "stdout", chunk: "line 1\n" };
        yield { type: "context.microcompacted", clearedResults: 3 };
        yield { type: "model.message", content: "answer" };
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "think hard", mode: "ask", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");

    const events = rx.frames.filter((f) => f.type === "event").map((f) => f.event);
    // Same-kind deltas are coalesced into one frame ("hmm " + "ok"); the
    // model.delta that follows forces the reasoning buffer to flush first.
    expect(events).toContainEqual({ type: "reasoning.delta", chunk: "hmm ok" });
    expect(events).toContainEqual({ type: "model.delta", chunk: "answer" });
    // Reasoning deltas arrive before the model delta (callback order preserved).
    const reasoningIdx = events.findIndex((e) => (e as { type: string }).type === "reasoning.delta");
    const modelIdx = events.findIndex((e) => (e as { type: string }).type === "model.delta");
    expect(reasoningIdx).toBeGreaterThanOrEqual(0);
    expect(reasoningIdx).toBeLessThan(modelIdx);
    // The new AgentEvents pass through unchanged.
    expect(events).toContainEqual({ type: "command.output", stream: "stdout", chunk: "line 1\n" });
    expect(events).toContainEqual({ type: "context.microcompacted", clearedResults: 3 });
  });

  it("coalesces a same-kind token burst into one frame and flushes on the timer", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "co-1" };
        opts.onModelDelta?.("a");
        opts.onModelDelta?.("b");
        // Wait well past DELTA_FLUSH_MS so "ab" flushes on the timer (there is
        // no intervening structured event to force it out).
        await new Promise((r) => setTimeout(r, 100));
        opts.onModelDelta?.("c");
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "burst", mode: "ask", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");

    const chunks = rx.frames
      .filter((f) => f.type === "event" && (f.event as { type: string }).type === "model.delta")
      .map((f) => (f.event as { chunk: string }).chunk);
    // "a"+"b" coalesce (timer flush); "c" flushes with session.completed.
    expect(chunks).toEqual(["ab", "c"]);
  });

  it("forwards provider.retry events verbatim (generic forwarder)", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* () {
        yield { type: "session.created", sessionId: "retry-1" };
        yield { type: "provider.retry", attempt: 2, maxAttempts: 3, delayMs: 1000, reason: "rate limited" };
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");

    const events = rx.frames.filter((f) => f.type === "event").map((f) => f.event);
    expect(events).toContainEqual({
      type: "provider.retry",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 1000,
      reason: "rate limited",
    });
  });

  it("forwards session.failed with recoverable + sessionId for resume guidance", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* () {
        yield { type: "session.created", sessionId: "fail-1" };
        yield {
          type: "session.failed",
          error: { code: "rate_limit", message: "boom", hint: "wait", recoverable: true, sessionId: "fail-1" },
        };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");

    const events = rx.frames.filter((f) => f.type === "event").map((f) => f.event);
    expect(events).toContainEqual({
      type: "session.failed",
      error: { code: "rate_limit", message: "boom", hint: "wait", recoverable: true, sessionId: "fail-1" },
    });
  });
});

describe("question bridge (ask_user)", () => {
  const questionScript = (observe: (answer: string) => void): CreateAgentFn =>
    fakeAgentFactory(async function* (opts) {
      yield { type: "session.created", sessionId: "q-1" };
      const answer = await opts.askUser!({
        question: "Which database?",
        options: ["Postgres", "SQLite"],
      });
      observe(answer);
      yield { type: "session.completed", report: emptyReport() };
    });

  it("round-trips question.request/question.answer", async () => {
    let answerSeen: string | undefined;
    const { server } = await boot(questionScript((a) => (answerSeen = a)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "ask me", mode: "edit", approvalMode: "auto" });
    const req = await rx.waitFor((f) => f.type === "question.request");
    expect(req).toMatchObject({
      question: "Which database?",
      options: ["Postgres", "SQLite"],
    });
    expect(typeof req.id).toBe("string");

    sendFrame(ws, { type: "question.answer", id: req.id, answer: "SQLite" });
    await rx.waitFor((f) => f.type === "idle");
    expect(answerSeen).toBe("SQLite");
  });

  it("resolves a declined answer when the socket closes without an answer", async () => {
    let answerSeen: string | undefined;
    const { server } = await boot(questionScript((a) => (answerSeen = a)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "ask me", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "question.request");

    ws.close();
    await waitUntil(() => answerSeen !== undefined);
    expect(answerSeen).toBe("(the user declined to answer)");
  });

  it("treats an empty answer as declined and rejects unknown question ids", async () => {
    let answerSeen: string | undefined;
    const { server } = await boot(questionScript((a) => (answerSeen = a)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "ask me", mode: "edit", approvalMode: "auto" });
    const req = await rx.waitFor((f) => f.type === "question.request");

    sendFrame(ws, { type: "question.answer", id: "q999", answer: "x" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_request");

    sendFrame(ws, { type: "question.answer", id: req.id, answer: "" });
    await rx.waitFor((f) => f.type === "idle");
    expect(answerSeen).toBe("(the user declined to answer)");
  });
});

describe("plan flavor and mode override", () => {
  function seedAskSession(workspace: string, id = "plan-1"): void {
    writeFileIn(
      workspace,
      `.seekforge/sessions/${id}/session.json`,
      JSON.stringify({
        id,
        task: "make a plan",
        mode: "ask",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
  }

  it("start with plan:true passes plan through to runTask", async () => {
    const inputs: RunAgentTaskInput[] = [];
    const { server } = await boot(recordingAgentFactory(inputs));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "plan it", mode: "ask", approvalMode: "confirm", plan: true });
    await rx.waitFor((f) => f.type === "idle");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ task: "plan it", mode: "ask", plan: true });
  });

  it("start without plan leaves it unset", async () => {
    const inputs: RunAgentTaskInput[] = [];
    const { server } = await boot(recordingAgentFactory(inputs));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "no plan", mode: "ask", approvalMode: "confirm" });
    await rx.waitFor((f) => f.type === "idle");
    expect(inputs[0]?.plan).toBeUndefined();
  });

  it("rejects a non-boolean plan", async () => {
    const { server } = await boot(recordingAgentFactory([]));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "start", task: "x", mode: "ask", approvalMode: "confirm", plan: "yes" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");
  });

  it('send with mode:"edit" overrides the session\'s ask mode (plan -> execute)', async () => {
    const inputs: RunAgentTaskInput[] = [];
    const workspace = makeWorkspace();
    seedAskSession(workspace);
    const { server } = await boot(recordingAgentFactory(inputs), workspace);
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "send", sessionId: "plan-1", task: "execute the plan", mode: "edit" });
    await rx.waitFor((f) => f.type === "idle");

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      resumeSessionId: "plan-1",
      task: "execute the plan",
      mode: "edit",
      approvalMode: "confirm",
    });
  });

  it("send without mode keeps the session's own mode", async () => {
    const inputs: RunAgentTaskInput[] = [];
    const workspace = makeWorkspace();
    seedAskSession(workspace);
    const { server } = await boot(recordingAgentFactory(inputs), workspace);
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "send", sessionId: "plan-1", task: "go on" });
    await rx.waitFor((f) => f.type === "idle");
    expect(inputs[0]).toMatchObject({ resumeSessionId: "plan-1", mode: "ask" });
  });

  it("rejects an invalid send mode", async () => {
    const workspace = makeWorkspace();
    seedAskSession(workspace);
    const { server } = await boot(recordingAgentFactory([]), workspace);
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "send", sessionId: "plan-1", task: "x", mode: "plan" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");
  });
});

describe("override + output-style contract (frame -> agent)", () => {
  it("start overrides (model/thinking/reasoningEffort) reach createAgent opts", async () => {
    let overrides: unknown;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        overrides = opts.overrides;
        yield { type: "session.created", sessionId: "ov-1" };
        yield { type: "session.completed", report: emptyReport("ok") };
      }),
    );
    const { ws, rx } = await open(server.port);
    sendFrame(ws, {
      type: "start",
      task: "go",
      mode: "edit",
      approvalMode: "auto",
      model: "deepseek-v4-pro",
      thinking: true,
      reasoningEffort: "max",
      sandbox: "read-only",
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(overrides).toMatchObject({ model: "deepseek-v4-pro", thinking: true, reasoningEffort: "max" });
  });

  it("a built-in outputStyle resolves to appendSystemPrompt on runTask input", async () => {
    let seen: RunAgentTaskInput | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (_opts, input) {
        seen = input;
        yield { type: "session.created", sessionId: "os-1" };
        yield { type: "session.completed", report: emptyReport("ok") };
      }),
    );
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto", outputStyle: "concise" });
    await rx.waitFor((f) => f.type === "idle");
    expect(seen?.appendSystemPrompt).toBeDefined();
    expect(seen?.appendSystemPrompt).toContain("Concise");
  });

  it("rejects an empty-string override field (e.g. model)", async () => {
    const { server } = await boot(recordingAgentFactory([]));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "start", task: "x", mode: "edit", approvalMode: "auto", model: "" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");
  });
});

describe("busy rule", () => {
  it("rejects start/send while a run is active, accepts again after idle", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* (_opts, input) {
        yield { type: "session.created", sessionId: "busy-1" };
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "session.failed", error: { code: "cancelled", message: "cancelled by user" } };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "first", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event");

    sendFrame(ws, { type: "start", task: "second", mode: "edit", approvalMode: "auto" });
    const busy = await rx.waitFor((f) => f.type === "error");
    expect(busy.code).toBe("busy");

    sendFrame(ws, { type: "cancel" });
    await rx.waitFor((f) => f.type === "idle");

    // After idle a new start is accepted (and immediately cancelled again).
    sendFrame(ws, { type: "start", task: "third", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event" && (f.event as { type: string }).type === "session.created");
    sendFrame(ws, { type: "cancel" });
    await rx.waitFor((f) => f.type === "idle");
  });
});

describe("permission bridge", () => {
  const permissionScript = (observe: (result: ConfirmResult) => void): CreateAgentFn =>
    fakeAgentFactory(async function* (opts) {
      yield { type: "session.created", sessionId: "perm-1" };
      const result = await opts.confirm({
        toolName: "write_file",
        permission: "write",
        description: "Write a.txt",
        path: "a.txt",
      });
      observe(result);
      const allowed = typeof result === "boolean" ? result : result.allow;
      yield {
        type: "tool.completed",
        toolName: "write_file",
        result: { ok: allowed },
      };
      yield { type: "session.completed", report: emptyReport() };
    });

  it("round-trips permission.request/response with the raw request", async () => {
    let approvedSeen: ConfirmResult | undefined;
    const { server } = await boot(permissionScript((a) => (approvedSeen = a)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "write it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");
    expect(req.request).toEqual({
      toolName: "write_file",
      permission: "write",
      description: "Write a.txt",
      path: "a.txt",
    });

    sendFrame(ws, { type: "permission.response", requestId: req.requestId, approved: true });
    await rx.waitFor((f) => f.type === "idle");
    expect(approvedSeen).toBe(true);
  });

  it("forwards remember:session as the richer confirm result", async () => {
    let resultSeen: ConfirmResult | undefined;
    const { server } = await boot(permissionScript((r) => (resultSeen = r)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "write it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");
    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: true,
      remember: "session",
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(resultSeen).toEqual({ allow: true, remember: "session" });
  });

  it("a denied response with remember stays a bare false (no session grant)", async () => {
    let resultSeen: ConfirmResult | undefined;
    const { server } = await boot(permissionScript((r) => (resultSeen = r)));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "write it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");
    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: false,
      remember: "session",
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(resultSeen).toBe(false);
  });

  it("rejects responses for unknown requestIds", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "permission.response", requestId: "p999", approved: true });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_request");
  });

  it("permission.request forwards hunks when present", async () => {
    let seenRequest: import("@seekforge/shared").PermissionRequest | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "perm-hunks" };
        await opts.confirm({
          toolName: "apply_patch",
          permission: "write",
          description: "Apply 3 edits to src/a.ts",
          path: "src/a.ts",
          hunks: [
            { index: 0, preview: "@@ -1,5 +1,6 @@\n+new" },
            { index: 1, preview: "@@ -10,3 +10,4 @@\n change" },
            { index: 2, preview: "@@ -20,2 +21,3 @@\n+another" },
          ],
        });
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "edit it", mode: "edit", approvalMode: "confirm" });
    const req = (await rx.waitFor((f) => f.type === "permission.request")) as {
      type: "permission.request";
      requestId: string;
      request: import("@seekforge/shared").PermissionRequest;
    };
    expect(req.request.hunks!).toHaveLength(3);
    expect(req.request.hunks![0]).toEqual({ index: 0, preview: "@@ -1,5 +1,6 @@\n+new" });
    expect(req.request.hunks![2]).toEqual({ index: 2, preview: "@@ -20,2 +21,3 @@\n+another" });
    // Acknowledge so the run finishes.
    sendFrame(ws, { type: "permission.response", requestId: req.requestId, approved: true });
    await rx.waitFor((f) => f.type === "idle");
  });

  it("selectedHunks in response returns { allow: true, selectedHunks }", async () => {
    let resultSeen: import("@seekforge/shared").ConfirmResult | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "perm-sel" };
        resultSeen = await opts.confirm({
          toolName: "apply_patch",
          permission: "write",
          description: "Apply edits",
          path: "src/a.ts",
        });
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "edit it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");

    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: true,
      selectedHunks: [0, 2],
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(resultSeen).toEqual({ allow: true, selectedHunks: [0, 2] });
  });

  it("selectedHunks with approved:false is ignored (bare false returned)", async () => {
    let resultSeen: import("@seekforge/shared").ConfirmResult | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "perm-sel-deny" };
        resultSeen = await opts.confirm({
          toolName: "apply_patch",
          permission: "write",
          description: "Apply edits",
          path: "src/a.ts",
        });
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "edit it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");

    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: false,
      selectedHunks: [0, 2],
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(resultSeen).toBe(false);
  });

  it("denies malformed selectedHunks instead of widening approval to every hunk", async () => {
    let resultSeen: import("@seekforge/shared").ConfirmResult | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "perm-sel-invalid" };
        resultSeen = await opts.confirm({
          toolName: "apply_patch",
          permission: "write",
          description: "Apply edits",
          path: "src/a.ts",
        });
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "edit it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");
    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: true,
      selectedHunks: [0, -1, "2"],
    });

    await rx.waitFor((f) => f.type === "idle");
    expect(resultSeen).toBe(false);
  });

  it("selectedHunks takes precedence over remember:session", async () => {
    let resultSeen: import("@seekforge/shared").ConfirmResult | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts) {
        yield { type: "session.created", sessionId: "perm-sel-rem" };
        resultSeen = await opts.confirm({
          toolName: "apply_patch",
          permission: "write",
          description: "Apply edits",
          path: "src/a.ts",
        });
        yield { type: "session.completed", report: emptyReport() };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "edit it", mode: "edit", approvalMode: "confirm" });
    const req = await rx.waitFor((f) => f.type === "permission.request");

    sendFrame(ws, {
      type: "permission.response",
      requestId: req.requestId,
      approved: true,
      remember: "session",
      selectedHunks: [1],
    });
    await rx.waitFor((f) => f.type === "idle");
    // selectedHunks wins over remember:session.
    expect(resultSeen).toEqual({ allow: true, selectedHunks: [1] });
  });

  it("denies pending permissions and aborts the run when the socket closes", async () => {
    let approvedSeen: ConfirmResult | undefined;
    let abortedSeen: boolean | undefined;
    const { server } = await boot(
      fakeAgentFactory(async function* (opts, input) {
        yield { type: "session.created", sessionId: "perm-2" };
        approvedSeen = await opts.confirm({
          toolName: "run_command",
          permission: "execute",
          description: "Run a command",
          command: "rm -rf /tmp/x",
        });
        abortedSeen = input.signal?.aborted;
        yield { type: "session.failed", error: { code: "cancelled", message: "socket closed" } };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "run it", mode: "edit", approvalMode: "confirm" });
    await rx.waitFor((f) => f.type === "permission.request");

    ws.close();
    await waitUntil(() => approvedSeen !== undefined && abortedSeen !== undefined);
    expect(approvedSeen).toBe(false);
    expect(abortedSeen).toBe(true);
  });
});

describe("cancel", () => {
  it("aborts the running session via the AbortSignal", async () => {
    let abortedSeen = false;
    const { server } = await boot(
      fakeAgentFactory(async function* (_opts, input) {
        yield { type: "session.created", sessionId: "cancel-1" };
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        abortedSeen = input.signal?.aborted ?? false;
        yield { type: "session.failed", error: { code: "cancelled", message: "cancelled by user" } };
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "long job", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event" && (f.event as { type: string }).type === "session.created");

    sendFrame(ws, { type: "cancel" });
    const failed = await rx.waitFor(
      (f) => f.type === "event" && (f.event as { type: string }).type === "session.failed",
    );
    expect((failed.event as { error: { code: string } }).error.code).toBe("cancelled");
    await rx.waitFor((f) => f.type === "idle");
    expect(abortedSeen).toBe(true);
  });

  it("cancel without a running session is a protocol error", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "cancel" });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("not_running");
  });

  it("reports cancelled when an aborted agent throws instead of yielding a terminal event", async () => {
    const { server } = await boot(
      fakeAgentFactory(async function* (_opts, input) {
        yield { type: "session.created", sessionId: "cancel-throw" };
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) return resolve();
          input.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("provider aborted");
      }),
    );
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "long job", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "event" && (f.event as { type: string }).type === "session.created");
    sendFrame(ws, { type: "cancel" });

    const error = await rx.waitFor((f) => f.type === "error");
    expect(error.code).toBe("cancelled");
    await rx.waitFor((f) => f.type === "idle");
  });
});

describe("protocol errors", () => {
  it("rejects non-JSON and malformed frames", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);

    ws.send("not json");
    let err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");

    sendFrame(ws, { type: "start", task: "", mode: "edit", approvalMode: "auto" });
    err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");

    sendFrame(ws, { type: "wat" });
    err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");
  });
});

describe("per-run model/thinking overrides", () => {
  /** Factory that records the CreateAgentOptions of every run. */
  function overridesRecordingFactory(seen: Array<Record<string, unknown> | undefined>): CreateAgentFn {
    return (opts) => ({
      agent: {
        runTask: async function* (input: RunAgentTaskInput) {
          seen.push(opts.overrides as Record<string, unknown> | undefined);
          yield { type: "session.created", sessionId: input.resumeSessionId ?? "ovr-1" } as const;
          yield { type: "session.completed", report: emptyReport() } as const;
        },
      },
      dispose: () => {},
    });
  }

  it("start passes model/thinking/reasoningEffort to the agent factory", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const { server } = await boot(overridesRecordingFactory(seen));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, {
      type: "start",
      task: "go",
      mode: "edit",
      approvalMode: "auto",
      model: "deepseek-v4-pro",
      thinking: true,
      reasoningEffort: "max",
      sandbox: "read-only",
    });
    await rx.waitFor((f) => f.type === "idle");
    expect(seen).toEqual([{ model: "deepseek-v4-pro", thinking: true, reasoningEffort: "max", sandbox: "read-only" }]);
  });

  it("start without overrides leaves them undefined (config wins)", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const { server } = await boot(overridesRecordingFactory(seen));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto" });
    await rx.waitFor((f) => f.type === "idle");
    expect(seen).toEqual([undefined]);
  });

  it("send passes overrides too (per-message control on resumed sessions)", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const workspace = makeWorkspace();
    writeFileIn(
      workspace,
      ".seekforge/sessions/ovr-1/session.json",
      JSON.stringify({
        id: "ovr-1",
        task: "orig",
        mode: "edit",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { server } = await boot(overridesRecordingFactory(seen), workspace);
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "send", sessionId: "ovr-1", task: "more", thinking: false });
    await rx.waitFor((f) => f.type === "idle");
    expect(seen).toEqual([{ thinking: false }]);
  });

  it("rejects invalid override values as bad_frame", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto", model: "" });
    let err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto", thinking: "yes" });
    err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");

    sendFrame(ws, { type: "start", task: "go", mode: "edit", approvalMode: "auto", reasoningEffort: "low" });
    err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("bad_frame");
  });
});
