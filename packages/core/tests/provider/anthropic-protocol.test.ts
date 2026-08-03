import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
import { pricingSourceFor } from "../../src/provider/cost.js";
import { PROVIDER_PRESETS, resolveProviderConfig } from "../../src/provider/presets.js";
import {
  anthropicProtocol,
  mapAnthropicResponse,
  toAnthropicMessages,
} from "../../src/provider/protocols/anthropic.js";
import type { ChatMessage } from "@seekforge/shared";

/**
 * The Anthropic Messages protocol's half of the compatibility matrix.
 *
 * A chat-completions history and a Messages history disagree about where the
 * system prompt lives, where a tool result belongs, and what a tool call's
 * arguments are; each of those is a request the API rejects outright if the
 * translation is wrong, so each has a case here.
 */

const CAPABILITIES = PROVIDER_PRESETS["anthropic"]!.capabilities;
const MODEL = "claude-opus-5";

const build = (
  messages: ChatMessage[],
  stream = false,
  thinking: { thinking?: boolean; reasoningEffort?: "high" | "max" } = {},
): Record<string, unknown> => anthropicProtocol.buildBody(MODEL, { messages }, stream, thinking, CAPABILITIES);

describe("anthropic request shape", () => {
  it("posts to /messages with key-and-version headers, never a bearer token", () => {
    expect(anthropicProtocol.endpoint("https://api.anthropic.com/v1")).toBe("https://api.anthropic.com/v1/messages");
    const headers = anthropicProtocol.headers("sk-ant-key");
    expect(headers["x-api-key"]).toBe("sk-ant-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("always sends max_tokens, which the API requires, and never a sampling parameter", () => {
    const body = build([{ role: "user", content: "hi" }]);
    expect(typeof body["max_tokens"]).toBe("number");
    expect((body["max_tokens"] as number) > 0).toBe(true);
    // The current model line rejects temperature/top_p/top_k outright.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");

    const explicit = anthropicProtocol.buildBody(
      MODEL,
      { messages: [{ role: "user", content: "hi" }], maxTokens: 321, temperature: 0.4 },
      false,
      {},
      CAPABILITIES,
    );
    expect(explicit["max_tokens"]).toBe(321);
    expect(explicit).not.toHaveProperty("temperature");
  });

  it("hoists system messages out of the turn list", () => {
    const body = build([
      { role: "system", content: "you are terse" },
      { role: "user", content: "hi" },
      { role: "system", content: "and precise" },
    ]);
    expect(body["system"]).toBe("you are terse\n\nand precise");
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends tools with input_schema, the name this protocol uses", () => {
    const body = anthropicProtocol.buildBody(
      MODEL,
      {
        messages: [{ role: "user", content: "go" }],
        tools: [{ name: "inspect", description: "Inspect", parameters: { type: "object" } }],
      },
      false,
      {},
      CAPABILITIES,
    );
    expect(body["tools"]).toEqual([{ name: "inspect", description: "Inspect", input_schema: { type: "object" } }]);
  });

  it("asks for summarized thinking, because the default streams empty thinking blocks", () => {
    expect(build([{ role: "user", content: "x" }], false, { thinking: true })["thinking"]).toEqual({
      type: "adaptive",
      display: "summarized",
    });
    expect(build([{ role: "user", content: "x" }], false, { thinking: false })["thinking"]).toEqual({
      type: "disabled",
    });
    // Unset means "say nothing", exactly as on the DeepSeek line.
    expect(build([{ role: "user", content: "x" }])).not.toHaveProperty("thinking");
  });

  it("never asks for more than high effort while thinking is off (the API rejects it)", () => {
    const off = build([{ role: "user", content: "x" }], false, { thinking: false, reasoningEffort: "max" });
    expect(off["output_config"]).toEqual({ effort: "high" });
    const on = build([{ role: "user", content: "x" }], false, { thinking: true, reasoningEffort: "max" });
    expect(on["output_config"]).toEqual({ effort: "max" });
  });

  it("sends no thinking controls when the preset says the endpoint has none", () => {
    const body = anthropicProtocol.buildBody(
      MODEL,
      { messages: [{ role: "user", content: "x" }] },
      false,
      { thinking: true, reasoningEffort: "max" },
      { ...CAPABILITIES, thinking: false },
    );
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("output_config");
  });
});

describe("anthropic history mapping", () => {
  it("puts a turn's tool results in ONE following user message, as blocks", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: "on it",
        toolCalls: [
          { id: "call_a", name: "read_file", argumentsJson: '{"path":"a.ts"}' },
          { id: "call_b", name: "read_file", argumentsJson: '{"path":"b.ts"}' },
        ],
      },
      { role: "tool", content: "A", toolCallId: "call_a" },
      { role: "tool", content: "B", toolCallId: "call_b" },
      { role: "user", content: "thanks" },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "call_a", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "call_b", name: "read_file", input: { path: "b.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_a", content: "A" },
          { type: "tool_result", tool_use_id: "call_b", content: "B" },
        ],
      },
      { role: "user", content: "thanks" },
    ]);
  });

  it("drops an interrupted turn instead of sending it as a prefill", () => {
    // A run cancelled between the tool call and its result leaves an assistant
    // turn with an unanswered call. Dropping the call would leave that turn
    // trailing the request, which the current model line rejects as a prefill.
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "let me look", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{}" }] },
    ]);
    expect(messages).toEqual([{ role: "user", content: "go" }]);
  });

  it("keeps the history usable when one call's arguments never parsed", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", argumentsJson: "{not json" }] },
      { role: "tool", content: "", toolCallId: "c1" },
    ]);
    // The unreadable input degrades to {} rather than failing every later turn,
    // and a tool that printed nothing still answers its call.
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "c1", name: "read_file", input: {} }],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: "(no output)" }],
    });
  });
});

describe("anthropic response mapping", () => {
  it("reads text, thinking and tool_use blocks out of one response", () => {
    const response = mapAnthropicResponse(
      {
        content: [
          { type: "thinking", thinking: "weigh options" },
          { type: "text", text: "here" },
          { type: "tool_use", id: "toolu_1", name: "inspect", input: { path: "a.ts" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 4 },
      },
      MODEL,
      CAPABILITIES,
    );
    expect(response.content).toBe("here");
    expect(response.reasoningContent).toBe("weigh options");
    expect(response.toolCalls).toEqual([{ id: "toolu_1", name: "inspect", argumentsJson: '{"path":"a.ts"}' }]);
    expect(response.finishReason).toBe("tool_calls");
  });

  it("counts the whole prompt, not just the part that missed the cache", () => {
    // input_tokens is the UNCACHED remainder here; reporting it as the prompt
    // size would understate every cached turn — which is most of them.
    const usage = mapAnthropicResponse(
      {
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 1_000,
          output_tokens: 500,
          cache_read_input_tokens: 4_000,
          cache_creation_input_tokens: 2_000,
        },
      },
      MODEL,
      CAPABILITIES,
    ).usage;
    expect(usage.promptTokens).toBe(7_000);
    expect(usage.cacheHitTokens).toBe(4_000);
    expect(usage.completionTokens).toBe(500);
    // 3k miss @ $5/M + 4k hit @ $0.50/M + 500 out @ $25/M
    expect(usage.costUsd).toBeCloseTo((3_000 * 5 + 4_000 * 0.5 + 500 * 25) / 1_000_000, 10);
  });

  it("says why a refusal is empty instead of returning a blank turn", () => {
    const response = mapAnthropicResponse(
      {
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber" },
        usage: { input_tokens: 3, output_tokens: 0 },
      },
      MODEL,
      CAPABILITIES,
    );
    expect(response.finishReason).toBe("other");
    expect(response.content).toContain("cyber");
  });

  it("rejects a body that is not a Messages response", () => {
    expect(() => mapAnthropicResponse(null, MODEL, CAPABILITIES)).toThrow(/must be an object/);
    expect(() => mapAnthropicResponse({ stop_reason: "end_turn" }, MODEL, CAPABILITIES)).toThrow(/content blocks/);
    expect(() => mapAnthropicResponse({ type: "error", error: { message: "boom" } }, MODEL, CAPABILITIES)).toThrow(
      /boom/,
    );
  });
});

describe("anthropic streaming", () => {
  const feed = (events: unknown[], sessionOverrides?: { split?: boolean }) => {
    const session = anthropicProtocol.openStream(MODEL, CAPABILITIES);
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const text = events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("");
    if (sessionOverrides?.split) {
      // Chunk boundaries land mid-line on a real socket.
      for (let i = 0; i < text.length; i += 7) {
        session.feed(
          text.slice(i, i + 7),
          (d) => deltas.push(d),
          (r) => reasoning.push(r),
        );
      }
    } else {
      session.feed(
        text,
        (d) => deltas.push(d),
        (r) => reasoning.push(r),
      );
    }
    return { session, deltas, reasoning };
  };

  const TURN = [
    { type: "message_start", message: { usage: { input_tokens: 12, cache_read_input_tokens: 8 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "think" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hello " } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "world" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_9", name: "read_file" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];

  it("assembles a whole turn from its event log", () => {
    const { session, deltas, reasoning } = feed(TURN);
    expect(session.done).toBe(true);
    const result = session.finish();
    expect(deltas).toEqual(["hello ", "world"]);
    expect(reasoning).toEqual(["think"]);
    expect(result.content).toBe("hello world");
    expect(result.reasoningContent).toBe("think");
    expect(result.toolCalls).toEqual([{ id: "toolu_9", name: "read_file", argumentsJson: '{"path":"a.ts"}' }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage.promptTokens).toBe(20);
    expect(result.usage.completionTokens).toBe(7);
    expect(result.usage.cacheHitTokens).toBe(8);
  });

  it("survives chunk boundaries falling anywhere in the stream", () => {
    const { session, deltas } = feed(TURN, { split: true });
    const result = session.finish();
    expect(deltas.join("")).toBe("hello world");
    expect(result.toolCalls[0]?.argumentsJson).toBe('{"path":"a.ts"}');
  });

  it("refuses to report a truncated stream as a complete answer", () => {
    // A connection that drops after some text is not a short reply.
    const { session } = feed(TURN.slice(0, -1));
    expect(session.done).toBe(false);
    expect(() => session.finish()).toThrow(/message_stop/);
  });

  it("raises an in-band error event, which no HTTP status will report", () => {
    expect(() => feed([{ type: "error", error: { type: "overloaded_error", message: "overloaded" } }])).toThrow(
      /overloaded/,
    );
  });

  it("keeps tool calls that arrived without a stop_reason", () => {
    const { session } = feed([
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "n" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_stop" },
    ]);
    const result = session.finish();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("ignores garbage payloads rather than failing the turn", () => {
    const session = anthropicProtocol.openStream(MODEL, CAPABILITIES);
    session.feed("data: not-json\n\ndata: [1,2]\n\ndata: null\n\n");
    session.feed(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
    expect(session.finish().content).toBe("");
  });
});

describe("anthropic transport", () => {
  let server: Server;
  let baseUrl: string;
  const recorded: { path: string; headers: Record<string, string | string[] | undefined>; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        recorded.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(body) });
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 3 } } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "transport-ok" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        ]) {
          response.write(`event: e\ndata: ${JSON.stringify(event)}\n\n`);
        }
        response.end(`event: e\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("completes a real HTTP/SSE request through the preset", async () => {
    const provider = createDeepSeekProvider(
      resolveProviderConfig({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl, model: MODEL, thinking: true }),
    );
    const deltas: string[] = [];
    const result = await provider.chatStream(
      {
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "transport check" },
        ],
      },
      (delta) => deltas.push(delta),
    );

    expect(deltas).toEqual(["transport-ok"]);
    expect(result.content).toBe("transport-ok");
    expect(result.finishReason).toBe("stop");
    expect(result.usage.promptTokens).toBe(8);
    expect(result.usage.cacheHitTokens).toBe(3);
    expect(result.usage.costUsd).toBeGreaterThan(0);

    const request = recorded.at(-1)!;
    expect(request.path).toBe("/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-ant-test");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    expect(request.headers["authorization"]).toBeUndefined();
    expect(request.body).toMatchObject({
      model: MODEL,
      stream: true,
      system: "be terse",
      messages: [{ role: "user", content: "transport check" }],
      thinking: { type: "adaptive", display: "summarized" },
    });
  });
});

describe("anthropic pricing", () => {
  it("prices the models it ships and admits it cannot price the rest", () => {
    expect(pricingSourceFor("claude-opus-5", { costAccounting: true })).toBe("builtin");
    // A Claude id with no published rate here must not borrow DeepSeek's — the
    // number would be wrong by more than an order of magnitude.
    expect(pricingSourceFor("claude-imaginary-9", { costAccounting: true })).toBe("unavailable");
    // The fallback still stands in for other models of the vendor it belongs to.
    expect(pricingSourceFor("deepseek-imaginary-9", { costAccounting: true })).toBe("fallback");
  });
});
