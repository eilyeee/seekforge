import type { AgentEvent, ChatResponse, ProviderToolCall, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatProvider, ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";

export const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

export function response(partial: Partial<ChatResponse>): ChatResponse {
  return { content: "", toolCalls: [], usage: USAGE, finishReason: "stop", ...partial };
}

export function toolCall(id: string, name: string, args: unknown): ProviderToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) };
}

export function toolCallsResponse(...calls: ProviderToolCall[]): ChatResponse {
  return response({ toolCalls: calls, finishReason: "tool_calls" });
}

/** Provider that pops scripted responses and records incoming requests. */
export function fakeProvider(script: ChatResponse[]): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    const res = script.shift();
    if (!res) throw new Error("fake provider script exhausted");
    return res;
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

/** Provider that routes every request through a handler (for concurrency tests). */
export function routedProvider(
  handler: (req: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): ChatProvider & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const next = async (req: ChatRequest) => {
    requests.push(req);
    return handler(req);
  };
  return { model: "fake", requests, chat: next, chatStream: (req) => next(req) };
}

/** The parent loop's system prompt vs a dispatched subagent's prompt. */
export function isParentRequest(req: ChatRequest): boolean {
  return req.messages[0]!.content.includes("You are SeekForge");
}

export function fakeDispatcher(): ToolDispatcher & { calls: { call: ToolCall; policyMode: string }[] } {
  const calls: { call: ToolCall; policyMode: string }[] = [];
  return {
    calls,
    list: () => [
      { name: "read_file", description: "d", parameters: {} },
      { name: "write_file", description: "d", parameters: {} },
    ],
    execute: async (call: ToolCall, ctx: ToolContext): Promise<ToolResult> => {
      calls.push({ call, policyMode: ctx.policy.mode });
      return { ok: true, data: { done: call.name } };
    },
  };
}

export async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export function toolCompleted(events: AgentEvent[], toolName: string) {
  return events.filter((e) => e.type === "tool.completed" && e.toolName === toolName) as Extract<
    AgentEvent,
    { type: "tool.completed" }
  >[];
}

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void };

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Flushes all pending microtasks (and one macrotask turn). */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
