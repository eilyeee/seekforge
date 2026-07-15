import { describe, expect, it } from "vitest";
import type { FinalReport } from "@seekforge/shared";
import {
  appendUser,
  initialChatState,
  reduceEvent,
  type ChatState,
  type StreamEvent,
} from "./events";

function play(events: StreamEvent[], from: ChatState = initialChatState()): ChatState {
  return events.reduce(reduceEvent, from);
}

const usage = { promptTokens: 100, completionTokens: 10, cacheHitTokens: 60, costUsd: 0.005 };
const report: FinalReport = {
  summary: "done",
  changedFiles: ["a.ts"],
  commandsRun: ["pnpm test"],
  verification: "commands run: pnpm test",
  usage,
};

describe("reduceEvent", () => {
  it("captures the sessionId from session.created", () => {
    const s = play([{ type: "session.created", sessionId: "s-1" }]);
    expect(s.sessionId).toBe("s-1");
    expect(s.items).toHaveLength(0);
  });

  it("accumulates model.delta chunks into one streaming assistant item", () => {
    const s = play([
      { type: "model.delta", chunk: "Hel" },
      { type: "model.delta", chunk: "lo" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "Hello", streaming: true });
  });

  it("replaces streamed text with the final model.message", () => {
    const s = play([
      { type: "model.delta", chunk: "draft…" },
      { type: "model.message", content: "final text" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "final text", streaming: false });
  });

  it("adds an assistant item for model.message without prior deltas", () => {
    const s = play([{ type: "model.message", content: "hi" }]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "hi", streaming: false });
  });

  it("starts a new streaming item after a tool row interleaves", () => {
    const s = play([
      { type: "model.delta", chunk: "first" },
      { type: "model.message", content: "first" },
      { type: "tool.started", toolName: "read_file", args: {} },
      { type: "model.delta", chunk: "second" },
    ]);
    expect(s.items).toHaveLength(3);
    expect(s.items[2]).toMatchObject({ kind: "assistant", text: "second", streaming: true });
  });

  it("pairs tool.completed with the matching running tool row", () => {
    const s = play([
      { type: "tool.started", toolName: "read_file", args: { path: "a.ts" } },
      { type: "tool.completed", toolName: "read_file", result: { ok: true, data: { content: "x" } } },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "tool", name: "read_file", status: "ok" });
  });

  it("marks failed tool results as error", () => {
    const s = play([
      { type: "tool.started", toolName: "run_command", args: { command: "x" } },
      {
        type: "tool.completed",
        toolName: "run_command",
        result: { ok: false, error: { code: "denied", message: "no" } },
      },
    ]);
    expect(s.items[0]).toMatchObject({ kind: "tool", status: "error" });
  });

  it("renders update_plan as a plan checklist updated in place", () => {
    const v1: StreamEvent = {
      type: "tool.completed",
      toolName: "update_plan",
      result: { ok: true, data: { items: [{ step: "a", status: "in_progress" }, { step: "b", status: "pending" }] } },
    };
    const v2: StreamEvent = {
      type: "tool.completed",
      toolName: "update_plan",
      result: { ok: true, data: { items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }] } },
    };
    let s = play([{ type: "tool.started", toolName: "update_plan", args: {} }, v1]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "plan", items: [{ step: "a", status: "in_progress" }, { step: "b", status: "pending" }] });

    const planId = s.items[0]!.id;
    s = play([{ type: "tool.started", toolName: "read_file", args: {} }, v2], s);
    // still one plan item, same position/id, updated statuses
    const plans = s.items.filter((i) => i.kind === "plan");
    expect(plans).toHaveLength(1);
    expect(plans[0]!.id).toBe(planId);
    expect(plans[0]).toMatchObject({ items: [{ step: "a", status: "done" }, { step: "b", status: "in_progress" }] });
  });

  it("ignores malformed update_plan payloads", () => {
    const s = play([
      { type: "tool.completed", toolName: "update_plan", result: { ok: true, data: { items: [{ step: 1, status: "weird" }] } } },
    ]);
    expect(s.items).toHaveLength(0);
  });

  it("adds file.changed badges and context.compacted notices", () => {
    const s = play([
      { type: "file.changed", path: "src/a.ts" },
      { type: "context.compacted", droppedTurns: 3, summaryTokens: 200 },
    ]);
    expect(s.items[0]).toMatchObject({ kind: "file", path: "src/a.ts" });
    expect(s.items[1]).toMatchObject({ kind: "compacted", droppedTurns: 3, summaryTokens: 200 });
  });

  it("accumulates usage across session.completed reports and stops running", () => {
    let s = { ...initialChatState(), running: true };
    s = play([{ type: "session.completed", report }], s);
    s = { ...s, running: true };
    s = play([{ type: "session.completed", report }], s);
    expect(s.running).toBe(false);
    expect(s.usage).toEqual({ promptTokens: 200, completionTokens: 20, cacheHitTokens: 120, costUsd: 0.01 });
    expect(s.items.filter((i) => i.kind === "report")).toHaveLength(2);
  });

  it("stores the latest context.usage on the state without adding a row", () => {
    let s = play([{ type: "context.usage", usedTokens: 40_000, budgetTokens: 96_000, percent: 42 }]);
    expect(s.items).toHaveLength(0);
    expect(s.contextUsage).toEqual({ usedTokens: 40_000, budgetTokens: 96_000, percent: 42 });
    // a later event replaces the previous one
    s = play([{ type: "context.usage", usedTokens: 88_000, budgetTokens: 96_000, percent: 92 }], s);
    expect(s.contextUsage).toEqual({ usedTokens: 88_000, budgetTokens: 96_000, percent: 92 });
  });

  it("renders session.failed as a banner and stops running", () => {
    const s = play(
      [{ type: "session.failed", error: { code: "max_turns_exceeded", message: "boom" } }],
      { ...initialChatState(), running: true },
    );
    expect(s.running).toBe(false);
    expect(s.items[0]).toMatchObject({ kind: "failed", error: { code: "max_turns_exceeded" } });
  });

  it("carries recoverable + sessionId on a recoverable session.failed", () => {
    const s = play([
      {
        type: "session.failed",
        error: { code: "rate_limit", message: "boom", hint: "wait", recoverable: true, sessionId: "s-9" },
      },
    ]);
    expect(s.items[0]).toMatchObject({
      kind: "failed",
      error: { recoverable: true, sessionId: "s-9", hint: "wait" },
    });
  });

  it("sets a transient retry status (no row) and clears it on the next success", () => {
    let s = play([{ type: "provider.retry", attempt: 2, maxAttempts: 3, delayMs: 1000, reason: "rate limited" }]);
    expect(s.items).toHaveLength(0);
    expect(s.retry).toEqual({ attempt: 2, maxAttempts: 3, delayMs: 1000, reason: "rate limited" });
    s = play([{ type: "usage.updated", usage }], s);
    expect(s.retry).toBeNull();
  });

  it("clears the retry status when the session completes or fails", () => {
    let s = play([{ type: "provider.retry", attempt: 1, maxAttempts: 3, delayMs: 500, reason: "network error" }]);
    s = play([{ type: "session.failed", error: { code: "network", message: "down" } }], s);
    expect(s.retry).toBeNull();
  });

  it("ignores events without a dedicated row", () => {
    const s = play([
      { type: "step.started", title: "selecting skills" }, // not a subagent step
      { type: "usage.updated", usage },
      { type: "command.output", stream: "stdout", chunk: "x" },
    ]);
    expect(s.items).toHaveLength(0);
  });

  it("groups subagent step.started events into one substep card per agent", () => {
    const s = play([
      { type: "step.started", title: "[meta-prism] read_file" },
      { type: "step.started", title: "[meta-prism] list_files" },
      { type: "step.started", title: "[meta-scout] web_fetch" },
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ kind: "substep", agentId: "meta-prism", steps: ["read_file", "list_files"] });
    expect(s.items[1]).toMatchObject({ kind: "substep", agentId: "meta-scout", steps: ["web_fetch"] });
  });

  it("tracks a structured subagent lifecycle and caps its step history", () => {
    const steps: StreamEvent[] = Array.from({ length: 55 }, (_, index) => ({
      type: "subagent.step",
      dispatchId: "ag-1",
      agentId: "reviewer",
      task: "review security",
      status: "running",
      toolName: `tool-${index}`,
      subSessionId: "sub-1",
    }));
    const s = play([
      { type: "subagent.started", dispatchId: "ag-1", agentId: "reviewer", task: "review security", status: "running" },
      ...steps,
      {
        type: "subagent.completed",
        dispatchId: "ag-1",
        agentId: "reviewer",
        task: "review security",
        status: "done",
        resultSummary: "no findings",
        subSessionId: "sub-1",
      },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      kind: "subagent",
      dispatchId: "ag-1",
      status: "done",
      subSessionId: "sub-1",
      resultSummary: "no findings",
    });
    const item = s.items[0] as Extract<(typeof s.items)[number], { kind: "subagent" }>;
    expect(item.steps).toHaveLength(50);
    expect(item.steps[0]).toBe("tool-5");
  });

  it("keeps completed cards when a later run reuses a dispatch id", () => {
    const terminal: StreamEvent = {
      type: "subagent.completed",
      dispatchId: "ag-1",
      agentId: "reviewer",
      task: "first run",
      status: "done",
      resultSummary: "first done",
    };
    const s = play([
      { type: "subagent.started", dispatchId: "ag-1", agentId: "reviewer", task: "first run", status: "running" },
      terminal,
      { type: "subagent.started", dispatchId: "ag-1", agentId: "reviewer", task: "second run", status: "running" },
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ kind: "subagent", task: "first run", status: "done" });
    expect(s.items[1]).toMatchObject({ kind: "subagent", task: "second run", status: "running" });
  });

  it("ignores legacy subagent steps after the structured lifecycle starts", () => {
    const s = play([
      { type: "subagent.started", dispatchId: "ag-1", agentId: "reviewer", task: "review", status: "running" },
      { type: "step.started", title: "[reviewer] read_file" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "subagent", steps: [] });
  });

  it("accumulates reasoning.delta chunks into one streaming thinking item", () => {
    const s = play([
      { type: "reasoning.delta", chunk: "let me " },
      { type: "reasoning.delta", chunk: "think" },
    ]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: "thinking", text: "let me think", streaming: true });
  });

  it("collapses the thinking block once the answer starts streaming", () => {
    const s = play([
      { type: "reasoning.delta", chunk: "hmm" },
      { type: "model.delta", chunk: "Answer" },
    ]);
    expect(s.items).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ kind: "thinking", text: "hmm", streaming: false });
    expect(s.items[1]).toMatchObject({ kind: "assistant", text: "Answer", streaming: true });
  });

  it("collapses the thinking block when a tool call starts instead", () => {
    const s = play([
      { type: "reasoning.delta", chunk: "checking files" },
      { type: "tool.started", toolName: "read_file", args: {} },
    ]);
    expect(s.items[0]).toMatchObject({ kind: "thinking", streaming: false });
    expect(s.items[1]).toMatchObject({ kind: "tool", name: "read_file" });
  });

  it("starts a fresh thinking block per turn", () => {
    const s = play([
      { type: "reasoning.delta", chunk: "first" },
      { type: "model.message", content: "answer one" },
      { type: "reasoning.delta", chunk: "second" },
    ]);
    const thinking = s.items.filter((i) => i.kind === "thinking");
    expect(thinking).toHaveLength(2);
    expect(thinking[0]).toMatchObject({ text: "first", streaming: false });
    expect(thinking[1]).toMatchObject({ text: "second", streaming: true });
  });

  it("attaches command.output as a capped live tail on the running tool row", () => {
    let s = play([
      { type: "tool.started", toolName: "run_command", args: { command: "pnpm test" } },
      { type: "command.output", stream: "stdout", chunk: "line 1\nline 2\npar" },
      { type: "command.output", stream: "stdout", chunk: "tial\n" },
    ]);
    // Chunks ending mid-line are joined back together.
    expect(s.items[0]).toMatchObject({ kind: "tool", tail: "line 1\nline 2\npartial\n" });

    s = play([{ type: "command.output", stream: "stderr", chunk: "l4\nl5\nl6\nl7\n" }], s);
    const tool = s.items[0] as Extract<(typeof s.items)[number], { kind: "tool" }>;
    // Capped to the last COMMAND_TAIL_LINES split segments.
    expect(tool.tail!.split("\n").length).toBeLessThanOrEqual(5);
    expect(tool.tail).toContain("l7");
    expect(tool.tail).not.toContain("line 1");
  });

  it("drops the tail when the tool completes (the result has the full output)", () => {
    const s = play([
      { type: "tool.started", toolName: "run_command", args: { command: "ls" } },
      { type: "command.output", stream: "stdout", chunk: "a.ts\n" },
      { type: "tool.completed", toolName: "run_command", result: { ok: true, data: { output: "a.ts" } } },
    ]);
    expect(s.items[0]).toMatchObject({ kind: "tool", status: "ok", tail: undefined });
  });

  it("ignores command.output without a running tool row", () => {
    const s = play([{ type: "command.output", stream: "stdout", chunk: "orphan\n" }]);
    expect(s.items).toHaveLength(0);
  });

  it("adds a context.microcompacted notice row", () => {
    const s = play([{ type: "context.microcompacted", clearedResults: 4 }]);
    expect(s.items[0]).toMatchObject({ kind: "microcompacted", clearedResults: 4 });
  });

  it("appendUser adds a user item", () => {
    const s = appendUser(initialChatState(), "do the thing");
    expect(s.items[0]).toMatchObject({ kind: "user", text: "do the thing" });
  });

  it("assigns unique increasing ids", () => {
    const s = play([
      { type: "model.message", content: "a" },
      { type: "file.changed", path: "x" },
      { type: "model.message", content: "b" },
    ]);
    const ids = s.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });
});
