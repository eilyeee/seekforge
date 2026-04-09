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
