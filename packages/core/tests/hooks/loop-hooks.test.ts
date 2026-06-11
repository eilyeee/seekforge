import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import type { AgentDefinition } from "../../src/subagents/index.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function fakeProvider(script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

/** Dispatcher recording every execute(); lets us assert it was NOT called. */
function spyDispatcher(
  result: ToolResult,
  tools = [{ name: "run_command", description: "d", parameters: {} }],
): ToolDispatcher & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    list: () => tools,
    execute: async (call: ToolCall, _ctx: ToolContext) => {
      calls.push(call);
      return result;
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function toolCall(name: string, args: Record<string, unknown> = {}): ChatResponse {
  return response({
    toolCalls: [{ id: "t1", name, argumentsJson: JSON.stringify(args) }],
    finishReason: "tool_calls",
  });
}

describe("hooks (loop integration)", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loophooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do it", mode: "edit" as const, approvalMode: "auto" as const };

  it("blocks a tool when a matching preToolUse hook exits non-zero", async () => {
    const provider = fakeProvider([toolCall("run_command", { cmd: "ls" }), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: true, data: { ran: true } });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { preToolUse: [{ match: "run_command", command: "echo nope 1>&2; exit 1" }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    // execute must NOT have been called.
    expect(dispatcher.calls).toHaveLength(0);
    const completed = events.find(
      (e) => e.type === "tool.completed" && e.toolName === "run_command",
    ) as Extract<AgentEvent, { type: "tool.completed" }>;
    expect(completed.result.ok).toBe(false);
    expect(completed.result.ok === false && completed.result.error?.code).toBe("blocked_by_hook");
    expect(completed.result.ok === false && completed.result.error?.message).toContain("nope");
  });

  it("allows a tool when the preToolUse hook exits zero", async () => {
    const provider = fakeProvider([toolCall("run_command"), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: true, data: { ran: true } });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { preToolUse: [{ match: "run_command", command: "exit 0" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("does not block on a non-matching preToolUse hook", async () => {
    const provider = fakeProvider([toolCall("run_command"), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: true });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { preToolUse: [{ match: "git_*", command: "exit 1" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("fires postToolUse after a successful execute (advisory; never blocks even on non-zero)", async () => {
    const marker = join(workspace, "post.json");
    const provider = fakeProvider([toolCall("run_command"), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: true, data: { ok: 1 } });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { postToolUse: [{ match: "*", command: `cat > ${JSON.stringify(marker)}; exit 1` }] },
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.calls).toHaveLength(1);
    // non-zero postToolUse never fails the tool.
    const completed = events.find(
      (e) => e.type === "tool.completed" && e.toolName === "run_command",
    ) as Extract<AgentEvent, { type: "tool.completed" }>;
    expect(completed.result.ok).toBe(true);
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.event).toBe("postToolUse");
    expect(payload.toolName).toBe("run_command");
  });

  it("does not fire postToolUse when the execute fails", async () => {
    const marker = join(workspace, "post-fail.json");
    const provider = fakeProvider([toolCall("run_command"), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: false, error: { code: "boom", message: "x" } });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: { postToolUse: [{ match: "*", command: `cat > ${JSON.stringify(marker)}` }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(existsSync(marker)).toBe(false);
  });

  it("fires sessionEnd once with the final status", async () => {
    const marker = join(workspace, "end.json");
    const provider = fakeProvider([response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { sessionEnd: [{ command: `cat > ${JSON.stringify(marker)}` }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.event).toBe("sessionEnd");
    expect(payload.status).toBe("completed");
    expect(payload.sessionId).toBeTruthy();
    expect(Array.isArray(payload.changedFiles)).toBe(true);
  });

  it("does not fire hooks for the synthetic update_plan tool", async () => {
    const marker = join(workspace, "plan-hook.json");
    const provider = fakeProvider([toolCall("update_plan"), response({ content: "done" })]);
    const dispatcher = spyDispatcher({ ok: true, data: { items: [] } }, [
      { name: "update_plan", description: "d", parameters: {} },
    ]);
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      hooks: {
        preToolUse: [{ match: "*", command: `echo blocked 1>&2; cat > ${JSON.stringify(marker)}; exit 1` }],
      },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    // update_plan is not hookable: hook never ran, tool executed normally.
    expect(existsSync(marker)).toBe(false);
    expect(dispatcher.calls).toHaveLength(1);
  });

  it("emits context.usage once per turn with sane numbers", async () => {
    const provider = fakeProvider([toolCall("run_command"), response({ content: "done" })]);
    const agent = createAgentCore({
      provider,
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const ctxEvents = events.filter((e) => e.type === "context.usage") as Extract<
      AgentEvent,
      { type: "context.usage" }
    >[];
    expect(ctxEvents).toHaveLength(2); // two model turns
    for (const e of ctxEvents) {
      expect(e.usedTokens).toBeGreaterThan(0);
      expect(e.budgetTokens).toBeGreaterThan(e.usedTokens);
    }
    // occupancy grows as the conversation accumulates messages.
    expect(ctxEvents[1]!.usedTokens).toBeGreaterThanOrEqual(ctxEvents[0]!.usedTokens);
  });

  it("never fires hooks for nested subagent tool calls (depth > 0)", async () => {
    const marker = join(workspace, "nested-hook.json");
    const worker: AgentDefinition = {
      id: "worker",
      name: "Worker",
      description: "does nested work",
      triggers: [],
      mode: "edit",
      scope: "project",
    };
    // Parent: dispatch the worker, then finish. Worker: call run_command, then finish.
    // Both share this provider script in order.
    const provider = fakeProvider([
      response({
        toolCalls: [
          { id: "d1", name: "dispatch_agent", argumentsJson: JSON.stringify({ agentId: "worker", task: "go" }) },
        ],
        finishReason: "tool_calls",
      }),
      // nested worker turn 1: run a command (would match the hook if hooks fired)
      toolCall("run_command", { cmd: "ls" }),
      // nested worker turn 2: finish
      response({ content: "worker done" }),
      // parent final turn
      response({ content: "parent done" }),
    ]);
    const dispatcher = spyDispatcher({ ok: true, data: { ran: true } });
    const agent = createAgentCore({
      provider,
      dispatcher,
      confirm: async () => true,
      subagents: [worker],
      // A preToolUse hook that would block run_command if it ever fired nested.
      hooks: { preToolUse: [{ match: "run_command", command: `cat > ${JSON.stringify(marker)}; exit 1` }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    // The nested run_command must have executed (hook never fired for depth>0).
    expect(dispatcher.calls.some((c) => c.name === "run_command")).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });
});
