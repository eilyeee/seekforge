import { describe, expect, it } from "vitest";
import type { AgentEvent, FinalReport } from "@seekforge/shared";
import { chatReducer, initialState, type ChatItem, type ChatState } from "../model.js";

function reduce(state: ChatState, ...events: AgentEvent[]): ChatState {
  return events.reduce((s, event) => chatReducer(s, { type: "event", event }), state);
}

function base(): ChatState {
  return initialState("deepseek-chat");
}

describe("chatReducer streaming deltas", () => {
  it("coalesces consecutive deltas into one streaming assistant item", () => {
    let s = base();
    s = chatReducer(s, { type: "model-delta", chunk: "Hello" });
    s = chatReducer(s, { type: "model-delta", chunk: " world" });
    expect(s.items).toHaveLength(1);
    const item = s.items[0] as ChatItem & { kind: "assistant" };
    expect(item.kind).toBe("assistant");
    expect(item.text).toBe("Hello world");
    expect(item.streaming).toBe(true);
  });

  it("model.message closes the open streaming item without duplicating text", () => {
    let s = base();
    s = chatReducer(s, { type: "model-delta", chunk: "streamed" });
    s = reduce(s, { type: "model.message", content: "streamed" });
    expect(s.items).toHaveLength(1);
    const item = s.items[0] as ChatItem & { kind: "assistant" };
    expect(item.streaming).toBe(false);
    expect(item.text).toBe("streamed");
  });

  it("model.message materializes content when nothing streamed", () => {
    let s = base();
    s = reduce(s, { type: "model.message", content: "full reply" });
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as { text: string }).text).toBe("full reply");
  });

  it("run-end closes a still-open streaming item", () => {
    let s = base();
    s = chatReducer(s, { type: "model-delta", chunk: "partial" });
    s = chatReducer(s, { type: "run-end" });
    expect((s.items[0] as { streaming: boolean }).streaming).toBe(false);
  });
});

describe("chatReducer tool pairing", () => {
  it("pairs tool.completed with the running tool row by name", () => {
    let s = base();
    s = reduce(
      s,
      { type: "tool.started", toolName: "read_file", args: { path: "a.ts" } },
      { type: "tool.completed", toolName: "read_file", result: { ok: true, data: {} } },
    );
    expect(s.items).toHaveLength(1);
    expect((s.items[0] as { status: string }).status).toBe("ok");
  });

  it("marks failed tools as error with code/message", () => {
    let s = base();
    s = reduce(
      s,
      { type: "tool.started", toolName: "run_command", args: {} },
      { type: "tool.completed", toolName: "run_command", result: { ok: false, error: { code: "E", message: "boom" } } },
    );
    const item = s.items[0] as ChatItem & { kind: "tool" };
    expect(item.status).toBe("error");
    expect(item.error).toEqual({ code: "E", message: "boom" });
  });

  it("pairs with the most recent matching running row", () => {
    let s = base();
    s = reduce(
      s,
      { type: "tool.started", toolName: "grep", args: { q: "1" } },
      { type: "tool.started", toolName: "grep", args: { q: "2" } },
      { type: "tool.completed", toolName: "grep", result: { ok: true } },
    );
    const rows = s.items.filter((i) => i.kind === "tool") as Array<ChatItem & { kind: "tool" }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe("running");
    expect(rows[1]?.status).toBe("ok");
  });
});

describe("chatReducer plan upsert", () => {
  it("renders update_plan as a single upserted plan card", () => {
    let s = base();
    s = reduce(
      s,
      { type: "tool.started", toolName: "update_plan", args: { items: [] } },
      {
        type: "tool.completed",
        toolName: "update_plan",
        result: { ok: true, data: { items: [{ step: "a", status: "pending" }] } },
      },
    );
    let plans = s.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    // No leftover tool row for update_plan.
    expect(s.items.some((i) => i.kind === "tool")).toBe(false);

    // A second plan update mutates the same card in place.
    s = reduce(s, {
      type: "tool.completed",
      toolName: "update_plan",
      result: { ok: true, data: { items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }] } },
    });
    plans = s.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    expect((plans[0] as ChatItem & { kind: "plan" }).items).toHaveLength(2);
  });
});

describe("chatReducer context + report", () => {
  it("captures context.usage into status state without an item", () => {
    let s = base();
    const before = s.items.length;
    s = reduce(s, { type: "context.usage", usedTokens: 100, budgetTokens: 200, percent: 50 });
    expect(s.items).toHaveLength(before);
    expect(s.context).toEqual({ usedTokens: 100, budgetTokens: 200, percent: 50 });
  });

  it("accumulates cost on session.completed and appends a report item", () => {
    const report: FinalReport = {
      summary: "done",
      changedFiles: ["x.ts"],
      commandsRun: [],
      verification: "ok",
      usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 2, costUsd: 0.01 },
    };
    let s = base();
    s = reduce(s, { type: "session.completed", report });
    s = reduce(s, { type: "session.completed", report });
    expect(s.totalUsage.costUsd).toBeCloseTo(0.02);
    expect(s.totalUsage.promptTokens).toBe(20);
    expect(s.items.filter((i) => i.kind === "report")).toHaveLength(2);
  });

  it("records sessionId from session.created", () => {
    let s = base();
    s = reduce(s, { type: "session.created", sessionId: "sess-123" });
    expect(s.sessionId).toBe("sess-123");
  });

  it("appends an error notice on session.failed", () => {
    let s = base();
    s = reduce(s, { type: "session.failed", error: { code: "X", message: "nope" } });
    const item = s.items[0] as ChatItem & { kind: "notice" };
    expect(item.kind).toBe("notice");
    expect(item.tone).toBe("error");
    expect(item.text).toContain("nope");
  });
});

describe("chatReducer v2 state", () => {
  it("parses nested subagent step titles into agentId + title", () => {
    let s = base();
    s = reduce(s, { type: "step.started", title: "[explorer] read_file" });
    const step = s.items[0] as ChatItem & { kind: "step" };
    expect(step.agentId).toBe("explorer");
    expect(step.title).toBe("read_file");
    s = reduce(s, { type: "step.started", title: "turn 2" });
    expect((s.items[1] as ChatItem & { kind: "step" }).agentId).toBeUndefined();
  });

  it("keeps the scroll window anchored while new items arrive", () => {
    let s = base();
    for (let i = 0; i < 5; i += 1) s = chatReducer(s, { type: "notice", text: `n${i}` });
    s = chatReducer(s, { type: "scroll", delta: 3, max: 4 });
    expect(s.scrollOffset).toBe(3);
    s = chatReducer(s, { type: "notice", text: "newer" });
    expect(s.scrollOffset).toBe(4); // grew with the appended item
    s = chatReducer(s, { type: "scroll-latest" });
    expect(s.scrollOffset).toBe(0);
  });

  it("run-start resets the scroll offset", () => {
    let s = base();
    s = chatReducer(s, { type: "notice", text: "x" });
    s = chatReducer(s, { type: "scroll", delta: 1, max: 1 });
    s = chatReducer(s, { type: "run-start" });
    expect(s.scrollOffset).toBe(0);
  });

  it("overlay-move wraps around the candidate count", () => {
    let s = base();
    s = chatReducer(s, { type: "overlay", overlay: { kind: "palette", query: "", index: 0 } });
    s = chatReducer(s, { type: "overlay-move", delta: -1, count: 3 });
    expect(s.overlay).toMatchObject({ index: 2 });
    s = chatReducer(s, { type: "overlay-move", delta: 1, count: 3 });
    expect(s.overlay).toMatchObject({ index: 0 });
  });

  it("tracks background tasks from run_command/task_kill completions", () => {
    let s = base();
    s = reduce(
      s,
      { type: "tool.started", toolName: "run_command", args: { command: "npm run dev", background: true } },
      { type: "tool.completed", toolName: "run_command", result: { ok: true, data: { taskId: "bg-1" } } },
    );
    expect(s.bgTasks).toEqual([{ id: "bg-1", command: "npm run dev", status: "running" }]);
    s = reduce(
      s,
      { type: "tool.started", toolName: "task_kill", args: { taskId: "bg-1" } },
      { type: "tool.completed", toolName: "task_kill", result: { ok: true, data: { taskId: "bg-1" } } },
    );
    expect(s.bgTasks[0]?.status).toBe("exited");
  });

  it("appends diff items via the diff action", () => {
    let s = base();
    s = chatReducer(s, { type: "diff", path: "a.ts", lines: [{ kind: "add", text: "+x" }] });
    const item = s.items[0] as ChatItem & { kind: "diff" };
    expect(item.kind).toBe("diff");
    expect(item.path).toBe("a.ts");
  });
});

describe("chatReducer v2.1 (steering queue, shell, bg-sync, clear)", () => {
  it("queues and dequeues steering messages in order", () => {
    let s = base();
    s = chatReducer(s, { type: "queue", text: "first" });
    s = chatReducer(s, { type: "queue", text: "second" });
    expect(s.queue).toEqual(["first", "second"]);
    s = chatReducer(s, { type: "dequeue" });
    expect(s.queue).toEqual(["second"]);
    s = chatReducer(s, { type: "queue-clear" });
    expect(s.queue).toEqual([]);
  });

  it("appends shell items for ! passthrough output", () => {
    let s = base();
    s = chatReducer(s, { type: "shell", command: "ls", output: "a\nb", exitCode: 0 });
    const item = s.items[0] as ChatItem & { kind: "shell" };
    expect(item.kind).toBe("shell");
    expect(item.exitCode).toBe(0);
  });

  it("bg-sync replaces the task snapshot wholesale", () => {
    let s = base();
    s = chatReducer(s, { type: "bg-sync", tasks: [{ id: "bg-1", command: "dev", status: "running" }] });
    expect(s.bgTasks).toHaveLength(1);
    s = chatReducer(s, { type: "bg-sync", tasks: [] });
    expect(s.bgTasks).toEqual([]);
  });

  it("run-end no longer force-exits bg tasks (shared manager owns them)", () => {
    let s = base();
    s = chatReducer(s, { type: "bg-sync", tasks: [{ id: "bg-1", command: "dev", status: "running" }] });
    s = chatReducer(s, { type: "run-end" });
    expect(s.bgTasks[0]?.status).toBe("running");
  });

  it("clear resets transcript, session, queue and overlay", () => {
    let s = base();
    s = chatReducer(s, { type: "notice", text: "x" });
    s = chatReducer(s, { type: "set-session", sessionId: "s1" });
    s = chatReducer(s, { type: "queue", text: "q" });
    s = chatReducer(s, { type: "clear" });
    expect(s.items).toEqual([]);
    expect(s.sessionId).toBeUndefined();
    expect(s.queue).toEqual([]);
  });
});
