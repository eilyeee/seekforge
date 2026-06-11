import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import type { RunAgentTaskInput } from "@seekforge/core";
import { startServer, type CreateAgentFn, type RunningServer } from "../src/index.js";
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
let sockets: WebSocket[] = [];

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
});

describe("start -> events -> idle", () => {
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
    await rx.waitFor(
      (f) => f.type === "event" && (f.event as { type: string; chunk?: string }).chunk === "hel",
    );
    await rx.waitFor(
      (f) => f.type === "event" && (f.event as { type: string; chunk?: string }).chunk === "lo",
    );
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
    const delta = rx.frames.find(
      (f) => f.type === "event" && (f.event as { type: string }).type === "model.delta",
    );
    expect(delta).toMatchObject({ sessionId: "fake-1", event: { type: "model.delta", chunk: "hel" } });
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
  const permissionScript = (observe: (approved: boolean) => void): CreateAgentFn =>
    fakeAgentFactory(async function* (opts) {
      yield { type: "session.created", sessionId: "perm-1" };
      const approved = await opts.confirm({
        toolName: "write_file",
        permission: "write",
        description: "Write a.txt",
        path: "a.txt",
      });
      observe(approved);
      yield {
        type: "tool.completed",
        toolName: "write_file",
        result: { ok: approved },
      };
      yield { type: "session.completed", report: emptyReport() };
    });

  it("round-trips permission.request/response with the raw request", async () => {
    let approvedSeen: boolean | undefined;
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

  it("rejects responses for unknown requestIds", async () => {
    const { server } = await boot(fakeAgentFactory(async function* () {}));
    const { ws, rx } = await open(server.port);
    sendFrame(ws, { type: "permission.response", requestId: "p999", approved: true });
    const err = await rx.waitFor((f) => f.type === "error");
    expect(err.code).toBe("unknown_request");
  });

  it("denies pending permissions and aborts the run when the socket closes", async () => {
    let approvedSeen: boolean | undefined;
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
