import { describe, expect, it } from "vitest";
import type { ToolResult } from "@seekforge/shared";
import {
  MAX_STEER_MESSAGE_LENGTH,
  MAX_STEER_QUEUE_LENGTH,
  createDispatchManager,
} from "../../src/subagents/manager.js";
import { createEventQueue } from "../../src/subagents/events.js";
import { deferred, settle } from "./helpers.js";

const okResult = (report: string): ToolResult => ({
  ok: true,
  data: { agentId: "a", report, changedFiles: [], commandsRun: [] },
});

describe("createDispatchManager", () => {
  it("assigns sequential ids and tracks a run through done", async () => {
    const manager = createDispatchManager();
    const first = manager.start({
      agentId: "a",
      task: "t1",
      run: async (_signal, hooks) => {
        hooks.onSubSession("sess-1");
        hooks.onStep("read_file");
        hooks.onStep("search_text");
        return okResult("r1");
      },
    });
    const second = manager.start({ agentId: "b", task: "t2", run: async () => okResult("r2") });
    expect(first.id).toBe("ag-1");
    expect(second.id).toBe("ag-2");
    expect(manager.get("ag-1")!.status).toBe("running");

    await first.promise;
    const snap = manager.get("ag-1")!;
    expect(snap.status).toBe("done");
    expect(snap.agentId).toBe("a");
    expect(snap.task).toBe("t1");
    expect(snap.subSessionId).toBe("sess-1");
    expect(snap.steps).toEqual(["read_file", "search_text"]);
    expect(snap.result).toEqual(okResult("r1"));
    expect(manager.list().map((s) => s.id)).toEqual(["ag-1", "ag-2"]);
  });

  it("maps !ok results and rejections to failed", async () => {
    const manager = createDispatchManager();
    const bad: ToolResult = { ok: false, error: { code: "subagent_failed", message: "nope" } };
    const a = manager.start({ agentId: "a", task: "t", run: async () => bad });
    const b = manager.start({
      agentId: "b",
      task: "t",
      run: async () => {
        throw new Error("boom");
      },
    });
    await a.promise;
    const rejected = await b.promise; // rejections are absorbed into the result
    expect(manager.get("ag-1")!.status).toBe("failed");
    expect(manager.get("ag-2")!.status).toBe("failed");
    expect(rejected).toEqual({ ok: false, error: { code: "subagent_failed", message: "boom" } });
  });

  it("disposeAll aborts every still-running dispatch (signal received)", async () => {
    const manager = createDispatchManager();
    let received: AbortSignal | undefined;
    const { promise } = manager.start({
      agentId: "a",
      task: "hang",
      run: (signal) => {
        received = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const done = manager.start({ agentId: "b", task: "quick", run: async () => okResult("r") });
    await done.promise;

    expect(received!.aborted).toBe(false);
    manager.disposeAll();
    expect(received!.aborted).toBe(true);
    await promise;
    expect(manager.get("ag-1")!.status).toBe("cancelled");
    expect(manager.get("ag-2")!.status).toBe("done"); // finished runs are untouched
  });

  it("chains the parent signal into the dispatch's own controller", async () => {
    const parent = new AbortController();
    const manager = createDispatchManager();
    let received: AbortSignal | undefined;
    const { promise } = manager.start({
      agentId: "a",
      task: "t",
      signal: parent.signal,
      run: (signal) => {
        received = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    await settle(); // the runner starts on a microtask
    expect(received!.aborted).toBe(false);
    parent.abort();
    expect(received!.aborted).toBe(true);
    await promise;
    expect(manager.get("ag-1")!.status).toBe("cancelled");
    expect(manager.get("ag-1")!.result?.error?.code).toBe("subagent_cancelled");
  });

  it("resume re-runs a completed dispatch and refuses running/unknown ones", async () => {
    const manager = createDispatchManager();
    const gate = deferred<void>();
    const { promise } = manager.start({
      agentId: "a",
      task: "first",
      run: async (_signal, hooks) => {
        hooks.onSubSession("sess-1");
        hooks.onStep("read_file");
        await gate.promise;
        return okResult("first report");
      },
    });
    expect(() => manager.resume({ id: "ag-1", task: "x", run: async () => okResult("y") })).toThrow(/running/);
    expect(() => manager.resume({ id: "ag-9", task: "x", run: async () => okResult("y") })).toThrow(/unknown/);

    gate.resolve();
    await promise;
    const result = await manager.resume({
      id: "ag-1",
      task: "follow up",
      run: async (_signal, hooks) => {
        hooks.onStep("search_text");
        return okResult("second report");
      },
    });
    expect(result.ok).toBe(true);
    const snap = manager.get("ag-1")!;
    expect(snap.status).toBe("done");
    expect(snap.task).toBe("follow up");
    expect(snap.subSessionId).toBe("sess-1"); // kept from the first run
    expect(snap.steps).toEqual(["read_file", "search_text"]); // append-only
    expect((snap.result!.data as { report: string }).report).toBe("second report");
  });

  it("queues bounded steering and drains it only when the runner asks", async () => {
    const manager = createDispatchManager();
    const gate = deferred<void>();
    let takeSteering: (() => string[]) | undefined;
    const { promise } = manager.start({
      agentId: "a",
      task: "first",
      run: async (_signal, hooks) => {
        takeSteering = hooks.takeSteering;
        await gate.promise;
        return okResult("done");
      },
    });
    await settle();

    expect(manager.steer("ag-1", "  focus on tests  ")).toEqual({ ok: true });
    expect(takeSteering!()).toEqual(["focus on tests"]);
    expect(takeSteering!()).toEqual([]);
    expect(manager.steer("ag-1", "x".repeat(MAX_STEER_MESSAGE_LENGTH + 1))).toMatchObject({
      ok: false,
      code: "invalid_steering",
    });
    for (let i = 0; i < MAX_STEER_QUEUE_LENGTH; i += 1) {
      expect(manager.steer("ag-1", `message ${i}`)).toEqual({ ok: true });
    }
    expect(manager.steer("ag-1", "overflow")).toMatchObject({ ok: false, code: "steering_queue_full" });

    gate.resolve();
    await promise;
    expect(manager.steer("ag-1", "too late")).toMatchObject({ ok: false, code: "dispatch_not_running" });
  });

  it("cancels one dispatch without failing or aborting its sibling", async () => {
    const manager = createDispatchManager();
    const run = (signal: AbortSignal) =>
      new Promise<ToolResult>((resolve) => {
        signal.addEventListener(
          "abort",
          () => resolve({ ok: false, error: { code: "aborted", message: "aborted" } }),
          { once: true },
        );
      });
    const first = manager.start({ agentId: "a", task: "first", run });
    const second = manager.start({ agentId: "b", task: "second", run });
    await settle();

    expect(manager.cancel("ag-1")).toEqual({ ok: true });
    expect(manager.get("ag-1")?.status).toBe("cancelled");
    expect(manager.get("ag-2")?.status).toBe("running");
    expect(manager.cancel("ag-1")).toMatchObject({ ok: false, code: "dispatch_not_running" });
    expect(manager.cancel("ag-99")).toMatchObject({ ok: false, code: "unknown_dispatch" });

    await first.promise;
    expect(manager.get("ag-1")?.result?.error?.code).toBe("subagent_cancelled");
    manager.disposeAll();
    await second.promise;
  });
});

describe("createEventQueue", () => {
  it("drainNow returns and clears the buffer; pushes after end are dropped", () => {
    const q = createEventQueue<number>();
    q.push(1);
    q.push(2);
    expect(q.drainNow()).toEqual([1, 2]);
    expect(q.drainNow()).toEqual([]);
    q.end();
    q.push(3);
    expect(q.drainNow()).toEqual([]);
  });

  it("wait resolves on push and immediately after end", async () => {
    const q = createEventQueue<string>();
    let woke = false;
    const waiting = q.wait().then(() => {
      woke = true;
    });
    await settle();
    expect(woke).toBe(false);
    q.push("a");
    await waiting;
    expect(q.drainNow()).toEqual(["a"]);
    q.end();
    await q.wait(); // must not hang
  });

  it("async-iterates until end", async () => {
    const q = createEventQueue<number>();
    q.push(1);
    const seen: number[] = [];
    const consume = (async () => {
      for await (const v of q) seen.push(v);
    })();
    await settle();
    q.push(2);
    q.push(3);
    q.end();
    await consume;
    expect(seen).toEqual([1, 2, 3]);
  });
});
