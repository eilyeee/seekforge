import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore, type AgentCoreDeps } from "../../src/agent/loop.js";
import { loadSessionMessages } from "../../src/agent/trace.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

const text = (content: string): ChatResponse => ({ content, toolCalls: [], usage: USAGE, finishReason: "stop" });
const call = (name: string, args: unknown): ChatResponse => ({
  content: "",
  toolCalls: [{ id: "c", name, argumentsJson: JSON.stringify(args) }],
  usage: USAGE,
  finishReason: "tool_calls",
});

/** Provider that plays a fixed script and records the messages it was sent. */
function scripted(model: string, script: ChatResponse[]) {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const p = {
    model,
    chats: 0,
    seen,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      p.chats++;
      seen.push(req.messages);
      return script[Math.min(i++, script.length - 1)]!;
    },
    chatStream(req: ChatRequest): Promise<ChatResponse> {
      return p.chat(req);
    },
  };
  return p;
}

const failing: ToolDispatcher = {
  list: () => [],
  execute: async (_c: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({
    ok: false,
    error: { code: "boom", message: "nope" },
  }),
};

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const hasText = (seen: ChatMessage[][], needle: string): boolean =>
  seen.some((msgs) => msgs.some((m) => typeof m.content === "string" && m.content.includes(needle)));

describe("stuck detection + failure escalation", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-escalation-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });
  const base = { task: "do it", approvalMode: "auto" as const };

  it("injects a reflection nudge when an identical tool call fails again (always on)", async () => {
    const provider = scripted("flash", [
      call("read_file", { path: "x" }),
      call("read_file", { path: "x" }),
      text("stop"),
    ]);
    const deps: AgentCoreDeps = { provider, dispatcher: failing, confirm: async () => true };
    await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    expect(hasText(provider.seen, "you are looping")).toBe(true);
  });

  it("does NOT trace the reflection nudge (preserves the one-user-message-per-run invariant)", async () => {
    const provider = scripted("flash", [
      call("read_file", { path: "x" }),
      call("read_file", { path: "x" }),
      text("stop"),
    ]);
    const deps: AgentCoreDeps = { provider, dispatcher: failing, confirm: async () => true };
    const events = await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    // The model received the nudge transiently...
    expect(hasText(provider.seen, "you are looping")).toBe(true);
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    // ...but the trace holds EXACTLY ONE role:"user" message (the task), and no nudge.
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.filter((m) => m.role === "user")).toHaveLength(1);
    expect(traced.some((m) => m.content.includes("you are looping"))).toBe(false);
  });

  it("does NOT trace the escalation note (preserves the one-user-message-per-run invariant)", async () => {
    const flash = scripted("flash", [call("read_file", { path: "x" }), call("read_file", { path: "x" })]);
    const pro = scripted("pro", [text("recovered")]);
    const deps: AgentCoreDeps = {
      provider: flash,
      dispatcher: failing,
      confirm: async () => true,
      planModel: "pro",
      providerForModel: () => pro,
      escalateOnFailure: true,
    };
    const events = await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    // The escalation note reached the (stronger) provider transiently...
    expect(hasText(pro.seen, "Escalated to pro")).toBe(true);
    const created = events.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";
    // ...but is absent from the trace, and only the task remains as a user message.
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.filter((m) => m.role === "user")).toHaveLength(1);
    expect(traced.some((m) => m.content.includes("Escalated to pro"))).toBe(false);
  });

  it("escalateOnFailure: a repeated failing call hands the run to planModel", async () => {
    const flash = scripted("flash", [call("read_file", { path: "x" }), call("read_file", { path: "x" })]);
    const pro = scripted("pro", [text("recovered")]);
    const requested: string[] = [];
    const deps: AgentCoreDeps = {
      provider: flash,
      dispatcher: failing,
      confirm: async () => true,
      planModel: "pro",
      providerForModel: (m) => {
        requested.push(m);
        return pro;
      },
      escalateOnFailure: true,
    };
    await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    expect(flash.chats).toBe(2);
    expect(pro.chats).toBe(1);
    expect(requested).toContain("pro");
  });

  it("detects a repeat even when the failing call's arg keys are reordered", async () => {
    // Same args, different key order → different raw argumentsJson, same
    // canonical signature → still caught as a loop (escalation fires).
    const flash = scripted("flash", [
      call("read_file", { path: "x", flag: true }),
      call("read_file", { flag: true, path: "x" }),
    ]);
    const pro = scripted("pro", [text("recovered")]);
    const deps: AgentCoreDeps = {
      provider: flash,
      dispatcher: failing,
      confirm: async () => true,
      planModel: "pro",
      providerForModel: () => pro,
      escalateOnFailure: true,
    };
    await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    expect(pro.chats).toBe(1);
  });

  it("escalateOnFailure off: stays on the default provider", async () => {
    const flash = scripted("flash", [call("read_file", { path: "x" }), call("read_file", { path: "x" }), text("stop")]);
    const pro = scripted("pro", [text("nope")]);
    const deps: AgentCoreDeps = {
      provider: flash,
      dispatcher: failing,
      confirm: async () => true,
      planModel: "pro",
      providerForModel: () => pro,
    };
    await collect(createAgentCore(deps).runTask({ ...base, projectPath: workspace, mode: "edit" }));
    expect(pro.chats).toBe(0);
  });
});
