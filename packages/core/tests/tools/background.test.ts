import { afterEach, describe, expect, it } from "vitest";
import { createBackgroundTasks, createDefaultDispatcher, type BackgroundTasks } from "../../src/tools/index.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

const dispatcher = createDefaultDispatcher();

const TICK_LOOP = "while true; do echo tick; sleep 0.05; done";

async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("createBackgroundTasks", () => {
  const managers: BackgroundTasks[] = [];
  const manager = (): BackgroundTasks => {
    const m = createBackgroundTasks();
    managers.push(m);
    return m;
  };
  afterEach(() => {
    for (const m of managers.splice(0)) m.disposeAll();
  });

  it("starts a task, captures growing output, and kills it", async () => {
    const ws = makeWorkspace();
    const bg = manager();
    const { id, pid } = bg.start({ command: TICK_LOOP, cwd: ws });
    expect(id).toBe("bg-1");
    expect(pid).toBeTypeOf("number");

    await waitFor(() => (bg.get(id)?.stdout ?? "").includes("tick"));
    const len1 = bg.get(id)!.stdout.length;
    await waitFor(() => bg.get(id)!.stdout.length > len1);

    expect(bg.get(id)!.status).toBe("running");
    expect(bg.get(id)!.runId).toMatch(/^run-bg-/);
    expect(bg.get(id)!.attempt).toBe(1);
    expect(bg.get(id)!.exitCode).toBeUndefined();

    bg.kill(id);
    bg.kill(id); // idempotent
    await waitFor(() => bg.get(id)!.status === "exited");
    const snap = bg.get(id)!;
    expect(snap.exitCode).toBeNull(); // killed, no exit code
    expect(snap.command).toBe(TICK_LOOP);
    expect(snap.durationMs).toBeGreaterThan(0);
    expect(processAlive(pid!)).toBe(false);
  });

  it("emits run lifecycle events", async () => {
    const events: Array<{ status: string; runId: string }> = [];
    const bg = createBackgroundTasks({ onEvent: (event) => events.push(event) });
    managers.push(bg);
    const task = bg.start({ command: "exit 3", cwd: makeWorkspace() });
    await waitFor(() => bg.get(task.id)?.status === "exited");
    expect(events.map((event) => event.status)).toEqual(["running", "failed"]);
    expect(events[0]!.runId).toBe(events[1]!.runId);
  });

  it("assigns sequential ids and lists summaries", async () => {
    const ws = makeWorkspace();
    const bg = manager();
    const a = bg.start({ command: "echo one", cwd: ws });
    const b = bg.start({ command: TICK_LOOP, cwd: ws });
    expect([a.id, b.id]).toEqual(["bg-1", "bg-2"]);

    await waitFor(() => bg.get(a.id)!.status === "exited");
    const summaries = bg.list();
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ id: "bg-1", command: "echo one", status: "exited" });
    expect(summaries[1]).toMatchObject({ id: "bg-2", command: TICK_LOOP, status: "running" });
    expect(bg.get(a.id)!.exitCode).toBe(0);
  });

  it("disposeAll kills every running task", async () => {
    const ws = makeWorkspace();
    const bg = manager();
    const t1 = bg.start({ command: TICK_LOOP, cwd: ws });
    const t2 = bg.start({ command: "sleep 30", cwd: ws });
    await waitFor(() => (bg.get(t1.id)?.stdout ?? "").includes("tick"));

    bg.disposeAll();
    await waitFor(() => bg.get(t1.id)!.status === "exited" && bg.get(t2.id)!.status === "exited");
    expect(processAlive(t1.pid!)).toBe(false);
    expect(processAlive(t2.pid!)).toBe(false);
  });

  it("caps each stream at the last 100_000 chars (ring buffer)", async () => {
    const ws = makeWorkspace();
    const bg = manager();
    // ~589k chars of stdout; the buffer must keep only the tail.
    const { id } = bg.start({ command: "seq 1 100000", cwd: ws });
    await waitFor(() => bg.get(id)!.status === "exited", 15_000);
    const snap = bg.get(id)!;
    expect(snap.exitCode).toBe(0);
    expect(snap.stdout.length).toBeLessThanOrEqual(100_000);
    expect(snap.stdout.trimEnd().endsWith("100000")).toBe(true);
    expect(snap.stdout).not.toContain("1\n2\n3\n"); // head was dropped
  });

  it("bounds the number of retained exited records without evicting running tasks", async () => {
    const ws = makeWorkspace();
    const bg = manager();

    // A long-running task started first must survive every eviction.
    const running = bg.start({ command: TICK_LOOP, cwd: ws });
    await waitFor(() => (bg.get(running.id)?.stdout ?? "").includes("tick"));

    // Start well over the retention cap of quick, exiting tasks.
    const exiting = Array.from({ length: 130 }, () => bg.start({ command: "true", cwd: ws }));
    await waitFor(() => exiting.every((t) => bg.get(t.id) === undefined || bg.get(t.id)!.status === "exited"), 15_000);

    // The Map is bounded: at most the retention cap of exited records survive,
    // so the oldest 30 of the 130 that ran were evicted rather than kept forever.
    const retainedExiting = exiting.filter((t) => bg.get(t.id) !== undefined);
    expect(retainedExiting.length).toBe(100);
    expect(bg.list().filter((s) => s.status === "exited").length).toBe(100);
    // The running task is never enqueued for eviction and remains queryable.
    expect(bg.get(running.id)?.status).toBe("running");
  });

  it("get and kill return undefined/false for unknown ids", () => {
    const bg = manager();
    expect(bg.get("bg-99")).toBeUndefined();
    expect(bg.kill("bg-99")).toBe(false);
  });
});

describe("run_command background:true via dispatcher", () => {
  it("returns a taskId without waiting for the command", async () => {
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    const ctx = makeCtx(ws, { background: bg });
    try {
      const started = Date.now();
      const res = await dispatcher.execute(call("run_command", { command: "sleep 5", background: true }), ctx);
      expect(Date.now() - started).toBeLessThan(2_000); // well under the sleep 5
      expect(res.ok).toBe(true);
      const data = res.data as { taskId: string; command: string; note: string };
      expect(data.taskId).toMatch(/^bg-\d+$/);
      expect(data.command).toBe("sleep 5");
      expect(data.note).toContain("task_output");
      expect(bg.get(data.taskId)?.status).toBe("running");
    } finally {
      bg.disposeAll();
    }
  });

  it("still denies denylisted commands with background:true", async () => {
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    const ctx = makeCtx(ws, { background: bg });
    const res = await dispatcher.execute(call("run_command", { command: "rm -rf /", background: true }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(bg.list()).toHaveLength(0);
  });

  it("fails with background_unavailable when the context has no manager", async () => {
    const ws = makeWorkspace();
    const res = await dispatcher.execute(call("run_command", { command: "sleep 5", background: true }), makeCtx(ws));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("background_unavailable");
  });
});

describe("task_output / task_kill via dispatcher", () => {
  it("polls output, applies the tail cap, and redacts secrets", async () => {
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    const ctx = makeCtx(ws, { background: bg });
    try {
      const { id } = bg.start({
        command: "echo MY_API_KEY=sk-abcdef1234567890abcdef; " + TICK_LOOP,
        cwd: ws,
      });
      await waitFor(() => (bg.get(id)?.stdout ?? "").includes("tick"));

      const res = await dispatcher.execute(call("task_output", { taskId: id }), ctx);
      expect(res.ok).toBe(true);
      const data = res.data as { status: string; stdout: string; durationMs: number };
      expect(data.status).toBe("running");
      expect(data.stdout).toContain("tick");
      expect(data.stdout).not.toContain("sk-abcdef1234567890abcdef");
      expect(data.durationMs).toBeGreaterThan(0);

      await waitFor(() => bg.get(id)!.stdout.length > 10);
      const tailRes = await dispatcher.execute(call("task_output", { taskId: id, tail: 10 }), ctx);
      expect((tailRes.data as { stdout: string }).stdout.length).toBeLessThanOrEqual(10);
    } finally {
      bg.disposeAll();
    }
  });

  it("returns unknown_task for ids it never started", async () => {
    const ws = makeWorkspace();
    const ctx = makeCtx(ws, { background: createBackgroundTasks() });
    const res = await dispatcher.execute(call("task_output", { taskId: "bg-42" }), ctx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("unknown_task");
  });

  it("task_kill terminates the task and reports the original command", async () => {
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    const ctx = makeCtx(ws, { background: bg });
    try {
      const { id, pid } = bg.start({ command: TICK_LOOP, cwd: ws });
      await waitFor(() => (bg.get(id)?.stdout ?? "").includes("tick"));

      const res = await dispatcher.execute(call("task_kill", { taskId: id }), ctx);
      expect(res.ok).toBe(true);
      expect(res.data).toMatchObject({ taskId: id, killed: true });
      // Raw command surfaced for the permission prompt / audit log.
      expect(res.meta?.command).toBe(TICK_LOOP);

      await waitFor(() => bg.get(id)!.status === "exited");
      expect(processAlive(pid!)).toBe(false);

      const status = await dispatcher.execute(call("task_output", { taskId: id }), ctx);
      expect((status.data as { status: string }).status).toBe("exited");
    } finally {
      bg.disposeAll();
    }
  });

  it("task_kill is unknown_task for missing ids and blocked in ask mode", async () => {
    const ws = makeWorkspace();
    const bg = createBackgroundTasks();
    const missing = await dispatcher.execute(call("task_kill", { taskId: "bg-7" }), makeCtx(ws, { background: bg }));
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("unknown_task");

    try {
      const { id } = bg.start({ command: TICK_LOOP, cwd: ws });
      const askCtx = makeCtx(ws, { background: bg, policy: { mode: "ask" } });
      const res = await dispatcher.execute(call("task_kill", { taskId: id }), askCtx);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("forbidden_in_ask_mode");
      expect(bg.get(id)!.status).toBe("running"); // not killed

      // task_output stays readable in ask mode (readonly).
      const out = await dispatcher.execute(call("task_output", { taskId: id }), askCtx);
      expect(out.ok).toBe(true);
    } finally {
      bg.disposeAll();
    }
  });
});
