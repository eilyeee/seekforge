import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import type { HookConfig } from "../../src/hooks/index.js";
import { createAgentCore } from "../../src/agent/loop.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

function fakeProvider(script: ChatResponse[]): ChatProvider {
  const next = async (_req: ChatRequest) => {
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", chat: next, chatStream: (req) => next(req) };
}

/** Dispatcher recording every execute() call and its ToolContext. */
function spyDispatcher(result: ToolResult): ToolDispatcher & { calls: ToolCall[]; contexts: ToolContext[] } {
  const calls: ToolCall[] = [];
  const contexts: ToolContext[] = [];
  return {
    calls,
    contexts,
    list: () => [{ name: "read_file", description: "d", parameters: {} }],
    execute: async (call: ToolCall, ctx: ToolContext) => {
      calls.push(call);
      contexts.push(ctx);
      return result;
    },
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("agent loop: hooks + context visibility", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loophooks-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { task: "do it", mode: "edit" as const, approvalMode: "auto" as const };

  it("passes the hook config to tools via ToolContext", async () => {
    const hooks: HookConfig = { preToolUse: [{ command: "exit 0" }] };
    const dispatcher = spyDispatcher({ ok: true });
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
      ]),
      dispatcher,
      confirm: async () => true,
      hooks,
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(dispatcher.contexts).toHaveLength(1);
    expect(dispatcher.contexts[0]!.hooks).toBe(hooks);
  });

  it("fires sessionEnd once with the final status when the session completes", async () => {
    const marker = join(workspace, "end.json");
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "done" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { sessionEnd: [{ command: "cat > end.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    expect(existsSync(marker)).toBe(true);
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.stage).toBe("sessionEnd");
    expect(payload.status).toBe("completed");
    expect(payload.sessionId).toBeTruthy();
    expect(payload.workspace).toBe(workspace);
  });

  it("fires sessionEnd with status cancelled when the run is aborted", async () => {
    const marker = join(workspace, "end-cancelled.json");
    const controller = new AbortController();
    controller.abort();
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "never" })]),
      dispatcher: spyDispatcher({ ok: true }),
      confirm: async () => true,
      hooks: { sessionEnd: [{ command: "cat > end-cancelled.json" }] },
    });
    await collect(agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }));
    const payload = JSON.parse(readFileSync(marker, "utf8"));
    expect(payload.status).toBe("cancelled");
  });

  it("emits context.usage after each provider response with a sane percent", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([
        response({
          toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
          finishReason: "tool_calls",
        }),
        response({ content: "done" }),
      ]),
      dispatcher: spyDispatcher({ ok: true, data: { content: "body" } }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const ctxEvents = events.filter((e) => e.type === "context.usage") as Extract<
      AgentEvent,
      { type: "context.usage" }
    >[];
    expect(ctxEvents).toHaveLength(2); // one per provider response
    for (const e of ctxEvents) {
      expect(e.usedTokens).toBeGreaterThan(0);
      expect(e.budgetTokens).toBeGreaterThan(e.usedTokens);
      expect(e.percent).toBe(Math.round((e.usedTokens / e.budgetTokens) * 100));
      expect(e.percent).toBeGreaterThanOrEqual(0);
      expect(e.percent).toBeLessThanOrEqual(100);
    }
    // occupancy grows as the conversation accumulates messages
    expect(ctxEvents[1]!.usedTokens).toBeGreaterThanOrEqual(ctxEvents[0]!.usedTokens);
    // and each context.usage follows a usage.updated emission
    const order = events.map((e) => e.type);
    expect(order.indexOf("context.usage")).toBe(order.indexOf("usage.updated") + 1);
  });
});
