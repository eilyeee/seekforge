import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import * as config from "../src/config.js";
import { RunManager, startServer, type RunningServer } from "../src/index.js";
import {
  RUN_EVENT_MAX_LINE_BYTES,
  RUN_EVENT_REPLAY_LIMIT,
  RunEventTooLargeError,
  RUNS_LEDGER_COMPACTION_THRESHOLD,
  RUNS_LEDGER_MAX_RETAINED,
} from "../src/run-ledger.js";
import { collectFrames, connectWs, emptyReport, fakeAgentFactory, makeWorkspace, waitUntil } from "./helpers.js";

const TOKEN = "run-test-token";
let server: RunningServer | undefined;
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

describe("append-only run ledger", () => {
  it("does not lose appends when multiple processes race ledger compaction", async () => {
    const workspace = makeWorkspace();
    const ledgerPath = join(workspace, ".seekforge/runs.jsonl");
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    const seeded = Array.from({ length: RUNS_LEDGER_COMPACTION_THRESHOLD }, (_, i) => {
      const ts = new Date(base + i).toISOString();
      return JSON.stringify({
        runId: `run-race-seed-${i}`,
        source: "background",
        status: "succeeded",
        attempt: 1,
        workspace,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(ledgerPath, `${seeded.join("\n")}\n`);

    const workerPath = join(import.meta.dirname, "fixtures/run-ledger-race-worker.ts");
    const goPath = join(workspace, "race-go");
    const workers = Array.from({ length: 4 }, (_, i) => `worker-${i}`);
    const children = workers.map((worker) => {
      const readyPath = join(workspace, `race-ready-${worker}`);
      const child = spawn(process.execPath, ["--import", "tsx", workerPath, workspace, worker, readyPath, goPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { child, readyPath };
    });
    await waitUntil(() => children.every(({ readyPath }) => existsSync(readyPath)), 15_000);
    writeFileSync(goPath, "go");
    await Promise.all(
      children.map(
        ({ child }) =>
          new Promise<void>((resolve, reject) => {
            let stderr = "";
            child.stderr?.on("data", (chunk) => {
              stderr += String(chunk);
            });
            child.once("error", reject);
            child.once("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)),
            );
          }),
      ),
    );

    const labels = new Set(
      new RunManager()
        .list(workspace)
        .map((record) => record.labels?.worker)
        .filter((worker): worker is string => worker !== undefined),
    );
    expect(labels).toEqual(new Set(workers));
  }, 30_000);

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

  it("rejects an oversized event before it can poison replay", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });

    expect(() =>
      manager.appendFrame(workspace, run.runId, { type: "event", data: "x".repeat(RUN_EVENT_MAX_LINE_BYTES) }),
    ).toThrow(RunEventTooLargeError);
    expect(manager.events(workspace, run.runId)).toEqual([]);
    expect(manager.appendFrame(workspace, run.runId, { type: "small" }).seq).toBe(1);
    expect(manager.events(workspace, run.runId)).toMatchObject([{ seq: 1, frame: { type: "small" } }]);
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

  it("persists waiting as a terminal non-failure state", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "loop" });
    manager.start(run.runId, workspace, new AbortController());
    manager.update(workspace, run.runId, { status: "waiting", sessionId: "loop-session" });
    expect(manager.get(workspace, run.runId)).toMatchObject({ status: "waiting", sessionId: "loop-session" });
    expect(manager.metrics()).toMatchObject({
      seekforge_runs_failed_total: 0,
      seekforge_runs_active: 0,
    });
    manager.update(workspace, run.runId, { status: "failed" });
    expect(manager.get(workspace, run.runId)?.status).toBe("waiting");
  });

  it("ignores malformed JSONL boundaries, forged optionals, and non-increasing seq", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "ws" });
    manager.appendFrame(workspace, run.runId, { type: "one" });
    appendFileSync(
      join(workspace, ".seekforge/runs.jsonl"),
      [
        "null",
        "[]",
        JSON.stringify({ ...run, status: "succeeded", costUsd: "free" }),
        '{"torn":',
        JSON.stringify({ ...run, status: "succeeded", updatedAt: new Date().toISOString() }),
        "",
      ].join("\n"),
    );
    const eventPath = join(workspace, ".seekforge/run-events", `${run.runId}.jsonl`);
    appendFileSync(
      eventPath,
      [
        JSON.stringify({ runId: run.runId, seq: 1, ts: new Date().toISOString(), frame: { type: "duplicate" } }),
        JSON.stringify({ runId: run.runId, seq: 0, ts: new Date().toISOString(), frame: { type: "zero" } }),
        JSON.stringify({ runId: run.runId, seq: 2, ts: "not-a-date", frame: { type: "bad-time" } }),
        "42",
        "",
      ].join("\n"),
    );
    expect(manager.get(workspace, run.runId)).toMatchObject({ status: "queued" });
    expect(manager.events(workspace, run.runId).map((event) => event.seq)).toEqual([1]);

    // The runs.jsonl ledger recovers its corrupt suffix on RESTART (a fresh
    // RunManager validates the file once on first touch), not on every hot
    // append — the append path no longer re-scans the whole file (O(N^2)). Its
    // longest valid prefix wins, so record state is not frozen after a torn write.
    const restartedLedger = new RunManager();
    restartedLedger.update(workspace, run.runId, { status: "running" });
    expect(restartedLedger.get(workspace, run.runId)).toMatchObject({ status: "running" });

    // The event log's corrupt suffix is repaired on RESTART: a fresh RunManager
    // (empty in-memory seq) recovers the last seq from the longest valid prefix
    // and continues, so replay is not permanently frozen after a torn write.
    const restarted = new RunManager();
    restarted.appendFrame(workspace, run.runId, { type: "after-recovery" });
    expect(restarted.events(workspace, run.runId).map((event) => event.seq)).toEqual([1, 2]);
  });

  it("increments seq in memory without re-scanning the whole event file per append", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });
    manager.start(run.runId, workspace, new AbortController());

    const eventRel = `.seekforge/run-events/${run.runId}.jsonl`;
    const actualReadProjectFile = config.readProjectFile;
    let eventReads = 0;
    const spy = vi.spyOn(config, "readProjectFile").mockImplementation((ws, rel) => {
      if (rel === eventRel) eventReads++;
      return actualReadProjectFile(ws, rel);
    });
    try {
      for (let i = 0; i < 25; i++) manager.appendFrame(workspace, run.runId, { type: `f${i}` });
    } finally {
      spy.mockRestore();
    }

    // Only the first append (cache miss) reads the event file back to recover the
    // seq; the other 24 just bump the in-memory counter. The old code re-read and
    // re-parsed the whole file on every append (O(N^2)). Keep reads O(1).
    expect(eventReads).toBeLessThanOrEqual(2);
    expect(manager.events(workspace, run.runId).map((event) => event.seq)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("SCH6: appends to runs.jsonl without re-reading+re-validating the whole file each time", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const actualRead = config.readProjectFile;
    let ledgerReads = 0;
    const spy = vi.spyOn(config, "readProjectFile").mockImplementation((ws, rel) => {
      if (rel === ".seekforge/runs.jsonl") ledgerReads++;
      return actualRead(ws, rel);
    });
    try {
      for (let i = 0; i < 40; i++) manager.create({ workspace, source: "background" });
    } finally {
      spy.mockRestore();
    }
    // The old append re-read + re-validated the ENTIRE ledger on every append
    // (O(N^2)). Now only the first touch validates/counts; the other 39 appends
    // just bump the in-memory line count. Keep ledger reads O(1).
    expect(ledgerReads).toBeLessThanOrEqual(3);
    expect(manager.list(workspace).length).toBe(40);
  });

  it("does not retry a ledger operation that throws ENOENT after acquiring the lease", () => {
    const workspace = makeWorkspace();
    const actualAppend = config.appendProjectFile;
    let attempts = 0;
    const spy = vi.spyOn(config, "appendProjectFile").mockImplementation((ws, rel, content) => {
      if (rel === ".seekforge/runs.jsonl") {
        attempts += 1;
        throw Object.assign(new Error("operation failed"), { code: "ENOENT" });
      }
      return actualAppend(ws, rel, content);
    });
    try {
      expect(() => new RunManager().create({ workspace, source: "background" })).toThrow("operation failed");
      expect(attempts).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("SCH6: compacts runs.jsonl to the latest record per run once it grows past the threshold", () => {
    const workspace = makeWorkspace();
    const ledgerPath = join(workspace, ".seekforge/runs.jsonl");
    // Seed the append log up to the threshold with distinct, valid records
    // (increasing updatedAt), so a single further append trips compaction.
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    const seeded = Array.from({ length: RUNS_LEDGER_COMPACTION_THRESHOLD }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString();
      return JSON.stringify({
        runId: `run-seed-${i}`,
        source: "background",
        status: "succeeded",
        attempt: 1,
        workspace,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(ledgerPath, `${seeded.join("\n")}\n`);

    const manager = new RunManager();
    // This create is the (threshold+1)th line → compaction fires.
    const created = manager.create({ workspace, source: "background" });

    const lines = readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "").length;
    // Compaction bounds the terminal runs at the retention cap, plus the one
    // still-queued run (non-terminal runs are always retained — see REG1 below).
    expect(lines).toBe(RUNS_LEDGER_MAX_RETAINED + 1);
    expect(lines).toBeLessThan(RUNS_LEDGER_COMPACTION_THRESHOLD);
    // The newest run (highest updatedAt) is retained and queryable...
    expect(manager.get(workspace, created.runId)).toMatchObject({ runId: created.runId, status: "queued" });
    // ...while the oldest terminal seed was evicted as least-recently-updated.
    expect(manager.get(workspace, "run-seed-0")).toBeUndefined();
    // Every retained line still parses as a valid ledger record.
    expect(manager.list(workspace).length).toBe(lines);
  });

  it("S4: redacts secrets in persisted event frames", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });
    manager.appendFrame(workspace, run.runId, { type: "model.delta", text: "the key is sk-ABCDEFGH12345678 ok" });
    const raw = readFileSync(join(workspace, ".seekforge/run-events", `${run.runId}.jsonl`), "utf8");
    expect(raw).not.toContain("sk-ABCDEFGH12345678");
    expect(raw).toContain("sk-A****");
    // Redaction keeps the line valid JSON, so replay still works.
    expect(() => manager.events(workspace, run.runId, 0)).not.toThrow();
  });

  it("S4: redacts nested multiline PEM values before serializing one valid JSONL record", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "SUPERSECRETKEYMATERIAL123456",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    manager.appendFrame(workspace, run.runId, {
      type: "tool.result",
      nested: { values: ["safe", privateKey] },
    });

    const raw = readFileSync(join(workspace, ".seekforge/run-events", `${run.runId}.jsonl`), "utf8");
    const lines = raw.split("\n").filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    expect(raw).not.toContain("SUPERSECRETKEYMATERIAL123456");
    expect(raw.match(/BEGIN PRIVATE KEY/g)).toHaveLength(1);
    expect(raw.match(/END PRIVATE KEY/g)).toHaveLength(1);
    expect(manager.events(workspace, run.runId)).toMatchObject([
      { frame: { nested: { values: ["safe", "-----BEGIN PRIVATE KEY-----\n****\n-----END PRIVATE KEY-----"] } } },
    ]);
  });

  it("D2: deletes the events file of a run evicted by compaction", () => {
    const workspace = makeWorkspace();
    const ledgerPath = join(workspace, ".seekforge/runs.jsonl");
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    const seeded = Array.from({ length: RUNS_LEDGER_COMPACTION_THRESHOLD }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString();
      return JSON.stringify({
        runId: `run-seed-${i}`,
        source: "background",
        status: "succeeded",
        attempt: 1,
        workspace,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    mkdirSync(join(workspace, ".seekforge/run-events"), { recursive: true });
    writeFileSync(ledgerPath, `${seeded.join("\n")}\n`);
    // An events file for the oldest seed (evicted first by compaction).
    const victimEvents = join(workspace, ".seekforge/run-events/run-seed-0.jsonl");
    writeFileSync(
      victimEvents,
      `${JSON.stringify({ runId: "run-seed-0", seq: 1, ts: new Date(base).toISOString(), frame: { type: "x" } })}\n`,
    );
    expect(existsSync(victimEvents)).toBe(true);

    const manager = new RunManager();
    manager.create({ workspace, source: "background" }); // trips compaction → evicts run-seed-0
    expect(manager.get(workspace, "run-seed-0")).toBeUndefined();
    expect(existsSync(victimEvents)).toBe(false);
  });

  it("D2: does not delete outside the workspace through a symlinked run-events directory", () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    const ledgerPath = join(workspace, ".seekforge/runs.jsonl");
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    const seeded = Array.from({ length: RUNS_LEDGER_COMPACTION_THRESHOLD }, (_, i) => {
      const ts = new Date(base + i * 1000).toISOString();
      return JSON.stringify({
        runId: `run-seed-${i}`,
        source: "background",
        status: "succeeded",
        attempt: 1,
        workspace,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(ledgerPath, `${seeded.join("\n")}\n`);
    const outsideVictim = join(outside, "run-seed-0.jsonl");
    writeFileSync(outsideVictim, "must survive");
    symlinkSync(outside, join(workspace, ".seekforge/run-events"), "dir");

    const manager = new RunManager();
    manager.create({ workspace, source: "background" });

    expect(manager.get(workspace, "run-seed-0")).toBeUndefined();
    expect(readFileSync(outsideVictim, "utf8")).toBe("must survive");
  });

  it("REG1: never evicts a non-terminal run, so its later terminal update still lands", () => {
    const workspace = makeWorkspace();
    const ledgerPath = join(workspace, ".seekforge/runs.jsonl");
    const base = Date.parse("2020-01-01T00:00:00.000Z");
    // The victim: a queued run with the OLDEST updatedAt — a recency-only cap
    // would evict it first. It must survive because it is non-terminal.
    const victim = JSON.stringify({
      runId: "run-victim",
      source: "background",
      status: "queued",
      attempt: 1,
      workspace,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
    });
    // Fill the rest of the threshold with newer terminal runs.
    const seeded = Array.from({ length: RUNS_LEDGER_COMPACTION_THRESHOLD - 1 }, (_, i) => {
      const ts = new Date(base + (i + 1) * 1000).toISOString();
      return JSON.stringify({
        runId: `run-seed-${i}`,
        source: "background",
        status: "succeeded",
        attempt: 1,
        workspace,
        createdAt: ts,
        updatedAt: ts,
      });
    });
    mkdirSync(join(workspace, ".seekforge"), { recursive: true });
    writeFileSync(ledgerPath, `${[victim, ...seeded].join("\n")}\n`);

    const manager = new RunManager();
    manager.create({ workspace, source: "background" }); // trips compaction

    // The oldest run survived compaction because it is still queued...
    expect(manager.get(workspace, "run-victim")).toMatchObject({ runId: "run-victim", status: "queued" });
    // ...so its terminal update is not silently dropped (get() found the record).
    const updated = manager.update(workspace, "run-victim", { status: "succeeded", costUsd: 0.1 });
    expect(updated).toMatchObject({ runId: "run-victim", status: "succeeded" });
  });

  it("drops the in-memory seq entry once a run reaches a terminal state", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const seqMap = (manager as unknown as { seq: Map<string, number> }).seq;

    const run = manager.create({ workspace, source: "background" });
    manager.start(run.runId, workspace, new AbortController());
    manager.appendFrame(workspace, run.runId, { type: "one" });
    expect(seqMap.has(run.runId)).toBe(true);

    manager.update(workspace, run.runId, { status: "succeeded" });
    manager.appendFrame(
      workspace,
      run.runId,
      { type: "event", event: { type: "session.completed" } },
      { cacheSequence: false },
    );
    // Terminal runs must not accumulate forever in the long-lived singleton.
    expect(seqMap.has(run.runId)).toBe(false);

    // A cancelled run is likewise dropped.
    const cancelled = manager.create({ workspace, source: "background" });
    manager.appendFrame(workspace, cancelled.runId, { type: "one" });
    manager.start(cancelled.runId, workspace, new AbortController());
    manager.cancel(workspace, cancelled.runId);
    expect(seqMap.has(cancelled.runId)).toBe(false);
  });

  it("streams event replay in bounded pages", () => {
    const workspace = makeWorkspace();
    const manager = new RunManager();
    const run = manager.create({ workspace, source: "background" });
    const eventDir = join(workspace, ".seekforge/run-events");
    mkdirSync(eventDir, { recursive: true });
    const ts = new Date().toISOString();
    const total = RUN_EVENT_REPLAY_LIMIT + 2;
    writeFileSync(
      join(eventDir, `${run.runId}.jsonl`),
      `${Array.from({ length: total }, (_, i) =>
        JSON.stringify({ runId: run.runId, seq: i + 1, ts, frame: { type: "event", index: i } }),
      ).join("\n")}\n`,
    );

    const first = manager.eventPage(workspace, run.runId, 0);
    expect(first).toMatchObject({ nextAfterSeq: RUN_EVENT_REPLAY_LIMIT, hasMore: true });
    expect(first.events).toHaveLength(RUN_EVENT_REPLAY_LIMIT);
    const second = manager.eventPage(workspace, run.runId, first.nextAfterSeq);
    expect(second).toMatchObject({ nextAfterSeq: total, hasMore: false });
    expect(second.events.map((event) => event.seq)).toEqual([total - 1, total]);
  });

  it("does not create missing directories through a project symlink", () => {
    const workspace = makeWorkspace();
    const outside = makeWorkspace();
    symlinkSync(outside, join(workspace, ".seekforge"), "dir");

    expect(() => config.appendProjectFile(workspace, ".seekforge/run-events/run-test.jsonl", "{}\n")).toThrow(
      /symlink/,
    );
    expect(existsSync(join(outside, "run-events"))).toBe(false);
  });
});

describe("run API and WS replay", () => {
  it("defaults Loop runs to edit mode and rejects ask mode", async () => {
    const workspace = makeWorkspace();
    let extractMemory: boolean | undefined;
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* () {}),
      runLoop: async (agentOpts, opts) => {
        extractMemory = agentOpts.extractMemory;
        const result = {
          status: "requirements_pending" as const,
          iterations: 0,
          costUsd: 0.001,
          sessionId: "loop-session",
          loopId: "loop-rest",
          finalVerify: { code: -1, output: "requirements await approval" },
        };
        opts.onEvent?.({ type: "loop.done", result });
        return result;
      },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "loop",
        task: "loop",
        verifyCommand: "pnpm test",
        maxCostUsd: 1,
        requirementMode: "confirm",
      }),
    });
    expect(response.status).toBe(202);
    const run = (await response.json()) as { runId: string };
    let record: { status: string; error?: unknown } | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await fetch(`http://127.0.0.1:${server?.port}/api/runs/${run.runId}`, { headers });
      record = (await current.json()) as { status: string; error?: unknown };
      if (record.status === "waiting") break;
      if (attempt === 99) throw new Error("Loop run did not reach waiting status");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(extractMemory).toBe(true);
    expect(record?.error).toBeUndefined();

    const rejected = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        kind: "loop",
        task: "loop",
        mode: "ask",
        verifyCommand: "pnpm test",
        maxCostUsd: 1,
      }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { code: "bad_request", message: 'loop mode must be "edit"' },
    });
  });

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
    const body = (await events.json()) as { events: Array<{ seq: number }> };
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

  it("does not report success when another server process owns cancellation", async () => {
    const workspace = makeWorkspace();
    let observedAbort = false;
    const factory = fakeAgentFactory(async function* (_opts, input) {
      yield { type: "session.created", sessionId: "remote-owner-session" };
      await new Promise<void>((resolve) => {
        const done = () => {
          observedAbort = true;
          resolve();
        };
        input.signal?.addEventListener("abort", done, { once: true });
        if (input.signal?.aborted) done();
      });
      yield { type: "session.failed", error: { code: "cancelled", message: "cancelled" } };
    });
    server = await startServer({ workspace, port: 0, token: TOKEN, createAgent: factory });
    const peer = await startServer({ workspace, port: 0, token: TOKEN, createAgent: factory });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    try {
      const started = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: "wait", mode: "ask", maxCostUsd: 1 }),
      });
      const run = (await started.json()) as { runId: string };
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`http://127.0.0.1:${server!.port}/api/runs/${run.runId}`, { headers });
        if (((await response.json()) as { status: string }).status === "running") break;
        if (attempt === 99) throw new Error("owned run did not start");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const remoteCancel = await fetch(`http://127.0.0.1:${peer.port}/api/runs/${run.runId}/cancel`, {
        method: "POST",
        headers,
      });
      expect(remoteCancel.status).toBe(409);
      expect(observedAbort).toBe(false);

      const ownerCancel = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}/cancel`, {
        method: "POST",
        headers,
      });
      expect(ownerCancel.status).toBe(200);
      await waitUntil(() => observedAbort);
    } finally {
      await peer.close();
    }
  });

  it("starts a headless background agent that survives subscriber disconnect and replays events", async () => {
    const workspace = makeWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
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
    const run = (await started.json()) as { runId: string; status: string };
    expect(run).toMatchObject({ status: "running" });

    const subscriber = await connectWs(server.port, TOKEN);
    const replay = collectFrames(subscriber);
    subscriber.send(JSON.stringify({ type: "subscribe", runId: run.runId, afterSeq: 0 }));
    await replay.waitFor((frame) => frame.type === "event");
    subscriber.terminate();
    release();

    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}`, { headers });
      if (((await response.json()) as { status: string }).status === "succeeded") break;
      if (attempt === 99) throw new Error("background run did not complete");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}/events?afterSeq=1`, { headers });
    const eventBody = (await events.json()) as { events: Array<{ seq: number; frame: { type: string } }> };
    expect(eventBody.events.some((event) => event.frame.type === "event" && event.seq > 1)).toBe(true);
  });

  it("keeps a subscription live through terminal delivery, then stops polling", async () => {
    const workspace = makeWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualIdentity = RunManager.prototype.eventFileIdentity;
    let polls = 0;
    const pageSpy = vi.spyOn(RunManager.prototype, "eventFileIdentity").mockImplementation(function (
      this: RunManager,
      ...args
    ) {
      polls += 1;
      return actualIdentity.apply(this, args);
    });
    try {
      server = await startServer({
        workspace,
        port: 0,
        token: TOKEN,
        logger: { log: () => {} },
        createAgent: fakeAgentFactory(async function* () {
          yield { type: "session.created", sessionId: "live-subscription" };
          await gate;
          yield { type: "session.completed", report: emptyReport("done") };
        }),
      });
      const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      const started = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: "background", mode: "ask", maxCostUsd: 1 }),
      });
      const run = (await started.json()) as { runId: string };
      const subscriber = await connectWs(server.port, TOKEN);
      sockets.push(subscriber);
      const replay = collectFrames(subscriber);
      subscriber.send(JSON.stringify({ type: "subscribe", runId: run.runId, afterSeq: 0 }));
      await replay.waitFor(
        (frame) => frame.type === "event" && (frame.event as { type?: string }).type === "session.created",
      );
      release();
      await replay.waitFor(
        (frame) => frame.type === "event" && (frame.event as { type?: string }).type === "session.completed",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const afterTerminal = polls;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(polls).toBe(afterTerminal);
    } finally {
      pageSpy.mockRestore();
    }
  });

  it("stops a subscription and reports an internal error when polling throws", async () => {
    const workspace = makeWorkspace();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualEventPage = RunManager.prototype.eventPage;
    let calls = 0;
    const pageSpy = vi.spyOn(RunManager.prototype, "eventPage").mockImplementation(function (
      this: RunManager,
      ...args
    ) {
      calls += 1;
      if (calls === 2) throw new Error("simulated replay failure");
      return actualEventPage.apply(this, args);
    });
    try {
      server = await startServer({
        workspace,
        port: 0,
        token: TOKEN,
        logger: { log: () => {} },
        createAgent: fakeAgentFactory(async function* () {
          yield { type: "session.created", sessionId: "poll-failure" };
          await gate;
          yield { type: "session.completed", report: emptyReport("done") };
        }),
      });
      const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
      const started = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ task: "background", mode: "ask", maxCostUsd: 1 }),
      });
      const run = (await started.json()) as { runId: string };
      const subscriber = await connectWs(server.port, TOKEN);
      sockets.push(subscriber);
      const replay = collectFrames(subscriber);
      subscriber.send(JSON.stringify({ type: "subscribe", runId: run.runId, afterSeq: 0 }));
      await replay.waitFor(
        (frame) => frame.type === "event" && (frame.event as { type?: string }).type === "session.created",
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(calls).toBe(1);

      const eventPath = join(workspace, ".seekforge/run-events", `${run.runId}.jsonl`);
      const persisted = readFileSync(eventPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { seq: number });
      appendFileSync(
        eventPath,
        `${JSON.stringify({
          runId: run.runId,
          seq: persisted.at(-1)!.seq + 1,
          ts: new Date().toISOString(),
          frame: { type: "event", sessionId: "poll-failure", event: { type: "external.frame" } },
        })}\n`,
      );
      const error = await replay.waitFor((frame) => frame.type === "error" && frame.code === "internal_error");
      expect(error.message).toBe("run subscription failed");
      const stoppedAt = calls;
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(calls).toBe(stoppedAt);
    } finally {
      release();
      pageSpy.mockRestore();
    }
  });

  it("starts and cancels a headless background loop", async () => {
    const workspace = makeWorkspace();
    let observedAbort = false;
    let loopStarted = false;
    server = await startServer({
      workspace,
      port: 0,
      token: TOKEN,
      logger: { log: () => {} },
      createAgent: fakeAgentFactory(async function* () {}),
      runLoop: async (_deps, opts) => {
        loopStarted = true;
        opts.onEvent?.({ type: "iteration.start", iteration: 1 });
        await new Promise<void>((resolve) => {
          const done = () => {
            observedAbort = true;
            resolve();
          };
          opts.signal?.addEventListener("abort", done, { once: true });
          if (opts.signal?.aborted) done();
        });
        throw new Error("loop aborted");
      },
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const response = await fetch(`http://127.0.0.1:${server.port}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "loop", task: "loop", verifyCommand: "pnpm test", maxCostUsd: 1 }),
    });
    const run = (await response.json()) as { runId: string };
    await waitUntil(() => loopStarted);
    const cancelled = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}`, {
      method: "DELETE",
      headers,
    });
    expect(await cancelled.json()).toMatchObject({ status: "cancelled" });
    await waitUntil(() => observedAbort);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const snapshot = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}`, { headers });
    expect(await snapshot.json()).toMatchObject({ status: "cancelled", error: { code: "cancelled" } });
    const events = await fetch(`http://127.0.0.1:${server.port}/api/runs/${run.runId}/events?afterSeq=0`, { headers });
    expect(((await events.json()) as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });
});
