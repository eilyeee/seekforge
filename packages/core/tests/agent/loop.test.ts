import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent, ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { createAgentCore } from "../../src/agent/loop.js";
import { listSessions, loadSessionMessages, readSessionMeta } from "../../src/agent/trace.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

/** Provider that pops scripted responses and records incoming requests. */
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

function fakeDispatcher(result: ToolResult): ToolDispatcher & { calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  return {
    calls,
    list: () => [{ name: "read_file", description: "d", parameters: {} }],
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

describe("agent loop", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  const baseInput = { projectPath: "", task: "do the thing", mode: "edit" as const, approvalMode: "auto" as const };

  it("completes when the model answers without tool calls", async () => {
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "## Summary\ndone" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));
    const done = events.find((e) => e.type === "session.completed");
    expect(done).toBeDefined();
    const sessions = listSessions(workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("completed");
    expect(sessions[0]!.usage?.costUsd).toBeCloseTo(0.001);
  });

  it("executes tool calls and feeds results back", async () => {
    const provider = fakeProvider([
      response({
        toolCalls: [{ id: "c1", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
        finishReason: "tool_calls",
      }),
      response({ content: "final" }),
    ]);
    const dispatcher = fakeDispatcher({ ok: true, data: { content: "file body" } });
    const agent = createAgentCore({ provider, dispatcher, confirm: async () => true });
    const events = await collect(agent.runTask({ ...baseInput, projectPath: workspace }));

    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]!.arguments).toEqual({ path: "a.ts" });
    // second request must contain the assistant tool-call msg + tool result msg
    const second = provider.requests[1]!.messages;
    expect(second.at(-2)!.toolCalls?.[0]!.name).toBe("read_file");
    expect(second.at(-1)!.role).toBe("tool");
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
  });

  it("cancels via AbortSignal and marks the session cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const agent = createAgentCore({
      provider: fakeProvider([response({ content: "never reached" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const events = await collect(
      agent.runTask({ ...baseInput, projectPath: workspace, signal: controller.signal }),
    );
    const failed = events.find((e) => e.type === "session.failed");
    expect(failed && failed.type === "session.failed" && failed.error.code).toBe("cancelled");
    expect(listSessions(workspace)[0]!.status).toBe("cancelled");
  });

  it("resumes a session with its prior messages", async () => {
    const first = createAgentCore({
      provider: fakeProvider([response({ content: "first answer" })]),
      dispatcher: fakeDispatcher({ ok: true }),
      confirm: async () => true,
    });
    const firstEvents = await collect(first.runTask({ ...baseInput, projectPath: workspace }));
    const created = firstEvents.find((e) => e.type === "session.created");
    const sessionId = created && created.type === "session.created" ? created.sessionId : "";

    const provider = fakeProvider([response({ content: "resumed answer" })]);
    const second = createAgentCore({ provider, dispatcher: fakeDispatcher({ ok: true }), confirm: async () => true });
    await collect(
      second.runTask({ ...baseInput, projectPath: workspace, task: "continue", resumeSessionId: sessionId }),
    );

    // resumed request must replay system + task + prior final answer + continuation
    const replayed: ChatMessage[] = provider.requests[0]!.messages;
    expect(replayed[0]!.role).toBe("system");
    expect(replayed.some((m) => m.content === "do the thing")).toBe(true);
    expect(replayed.some((m) => m.role === "assistant" && m.content === "first answer")).toBe(true);
    expect(replayed.at(-1)!.content).toBe("continue");
    expect(readSessionMeta(workspace, sessionId)!.status).toBe("completed");
    // trace now ends with the resumed run's final answer, preceded by the continuation
    const traced = loadSessionMessages(workspace, sessionId);
    expect(traced.at(-1)!.content).toBe("resumed answer");
    expect(traced.at(-2)!.content).toBe("continue");
  });
});
