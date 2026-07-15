import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { RunManager, startServer, type RunningServer } from "../src/index.js";
import { collectFrames, connectWs, emptyReport, fakeAgentFactory, makeWorkspace, waitUntil } from "./helpers.js";

const TOKEN = "run-test-token";
let server: RunningServer | undefined;
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

describe("append-only run ledger", () => {
  it("persists latest state and strictly increasing replay sequence", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background", attempt: 2 });
    manager.update(workspace, run.runId, { status: "running", sessionId: "s1" });
    expect(manager.appendFrame(workspace, run.runId, { type: "one" }).seq).toBe(1);
    expect(manager.appendFrame(workspace, run.runId, { type: "two" }).seq).toBe(2);
    manager.update(workspace, run.runId, { status: "succeeded", costUsd: 0.25 });

    expect(manager.get(workspace, run.runId)).toMatchObject({
      status: "succeeded",
      attempt: 2,
      sessionId: "s1",
      costUsd: 0.25,
    });
    expect(manager.events(workspace, run.runId, 1)).toMatchObject([{ seq: 2, frame: { type: "two" } }]);
  });

  it("does not let a late completion overwrite a cancelled terminal state", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });
    manager.start(run.runId, workspace, new AbortController());
    expect(manager.cancel(workspace, run.runId)?.status).toBe("cancelled");
    manager.update(workspace, run.runId, { status: "succeeded", costUsd: 1 });
    expect(manager.get(workspace, run.runId)?.status).toBe("cancelled");
  });

  it("ignores malformed JSONL boundaries, forged optionals, and non-increasing seq", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "ws" });
    manager.appendFrame(workspace, run.runId, { type: "one" });
    appendFileSync(join(workspace, ".seekforge/runs.jsonl"), [
      "null",
      "[]",
      JSON.stringify({ ...run, status: "succeeded", costUsd: "free" }),
      '{"torn":',
      JSON.stringify({ ...run, status: "succeeded", updatedAt: new Date().toISOString() }),
      "",
    ].join("\n"));
    const eventPath = join(workspace, ".seekforge/run-events", `${run.runId}.jsonl`);
    appendFileSync(eventPath, [
      JSON.stringify({ runId: run.runId, seq: 1, ts: new Date().toISOString(), frame: { type: "duplicate" } }),
      JSON.stringify({ runId: run.runId, seq: 0, ts: new Date().toISOString(), frame: { type: "zero" } }),
      JSON.stringify({ runId: run.runId, seq: 2, ts: "not-a-date", frame: { type: "bad-time" } }),
      "42",
      "",
    ].join("\n"));
    expect(manager.get(workspace, run.runId)).toMatchObject({ status: "queued" });
    expect(manager.events(workspace, run.runId).map((event) => event.seq)).toEqual([1]);

    // A later append repairs the corrupt suffix to the longest valid prefix,
    // so the ledger does not remain permanently frozen after a torn write.
    manager.update(workspace, run.runId, { status: "running" });
    manager.appendFrame(workspace, run.runId, { type: "after-recovery" });
    expect(manager.get(workspace, run.runId)).toMatchObject({ status: "running" });
    expect(manager.events(workspace, run.runId).map((event) => event.seq)).toEqual([1, 2]);
  });
});

describe("run API and WS replay", () => {
  it("advertises capabilities, queries a run, and replays afterSeq", async () => {
    const workspace = makeWorkspace();
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* () {
        yield { type: "session.created", sessionId: "ledger-session" };
        yield { type: "session.completed", report: emptyReport("done") };
      }),
    });
    const socket = await connectWs(server.port, TOKEN);
    sockets.push(socket);
    const rx = collectFrames(socket);
    socket.send(JSON.stringify({ type: "start", task: "test", mode: "ask", approvalMode: "auto" }));
    const accepted = await rx.waitFor((frame) => frame.type === "run.accepted");
    const id = accepted.runId as string;
    await rx.waitFor((frame) => frame.type === "idle");

    const headers = { authorization: `Bearer ${TOKEN}` };
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`, { headers });
    expect(await health.json()).toMatchObject({ protocolVersion: 1, ready: true });
    const queried = await fetch(`http://127.0.0.1:${server.port}/api/runs/${id}`, { headers });
    expect(await queried.json()).toMatchObject({ runId: id, status: "succeeded", sessionId: "ledger-session" });
    const events = await fetch(`http://127.0.0.1:${server.port}/api/runs/${id}/events?afterSeq=1`, { headers });
    const body = await events.json() as { events: Array<{ seq: number }> };
    expect(body.events.every((event) => event.seq > 1)).toBe(true);

    const reconnect = await connectWs(server.port, TOKEN);
    sockets.push(reconnect);
    const replay = collectFrames(reconnect);
    reconnect.send(JSON.stringify({ type: "subscribe", runId: id, afterSeq: 1 }));
    const replayed = await replay.waitFor((frame) => typeof frame.seq === "number" && (frame.seq as number) > 1);
    expect(replayed.runId).toBe(id);
  });

  it("cancels an active WS run through REST", async () => {
    const workspace = makeWorkspace();
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* (_opts, input) {
        yield { type: "session.created", sessionId: "cancel-session" };
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          input.signal?.addEventListener("abort", done, { once: true });
          if (input.signal?.aborted) done();
        });
        yield { type: "session.failed", error: { code: "cancelled", message: "cancelled by user" } };
      }),
    });
    const socket = await connectWs(server.port, TOKEN);
    sockets.push(socket);
    const rx = collectFrames(socket);
    socket.send(JSON.stringify({ type: "start", task: "wait", mode: "ask", approvalMode: "auto" }));
    const accepted = await rx.waitFor((frame) => frame.type === "run.accepted");
    const id = accepted.runId as string;
    await rx.waitFor((frame) => frame.type === "event" && (frame.event as { type: string }).type === "session.created");
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runs/${id}/cancel`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId: id, status: "cancelled" });
    await rx.waitFor((frame) => frame.type === "idle");
  });

  it("starts a headless background agent that survives subscriber disconnect and replays events", async () => {
    const workspace = makeWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* () {
        yield { type: "session.created", sessionId: "background-session" };
        await gate;
        yield { type: "session.completed", report: emptyReport("background done") };
      }),
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const started = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ task: "background", mode: "ask", maxCostUsd: 0.5 }),
    });
    expect(started.status).toBe(202);
    const run = await started.json() as { runId: string; status: string };
    expect(run).toMatchObject({ status: "running" });

    const subscriber = await connectWs(server.port, TOKEN);
    const replay = collectFrames(subscriber);
    subscriber.send(JSON.stringify({ type: "subscribe", runId: run.runId, afterSeq: 0 }));
    await replay.waitFor((frame) => frame.type === "event");
    subscriber.terminate();
    release();

    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}`, { headers });
      if ((await response.json() as { status: string }).status === "succeeded") break;
      if (attempt === 99) throw new Error("background run did not complete");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}/events?afterSeq=1`, { headers });
    const eventBody = await events.json() as { events: Array<{ seq: number; frame: { type: string } }> };
    expect(eventBody.events.some((event) => event.frame.type === "event" && event.seq > 1)).toBe(true);
  });

  it("starts and cancels a headless background loop", async () => {
    const workspace = makeWorkspace();
    let observedAbort = false;
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* () {}),
      runLoop: async (_deps, opts) => {
        opts.onEvent?.({ type: "iteration.start", iteration: 1 });
        await new Promise<void>((resolve) => {
          const done = () => { observedAbort = true; resolve(); };
          opts.signal?.addEventListener("abort", done, { once: true });
          if (opts.signal?.aborted) done();
        });
        const result = { status: "cancelled" as const, iterations: 1, costUsd: 0, sessionId: "loop-session", finalVerify: { code: 1, output: "cancelled" } };
        opts.onEvent?.({ type: "loop.done", result });
        return result;
      },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "loop", task: "loop", verifyCommand: "pnpm test", maxCostUsd: 1 }),
    });
    const run = await response.json() as { runId: string };
    const cancelled = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}`, { method: "DELETE", headers });
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    await waitUntil(() => observedAbort);
    const events = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}/events?afterSeq=0`, { headers });
    expect((await events.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
});
