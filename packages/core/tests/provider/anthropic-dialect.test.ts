// Wire-shape fixtures for the Anthropic Messages stream.
//
// The OpenAI-compatible line has dialects.test.ts, where five providers spell
// the same protocol differently. This protocol has one vendor and therefore no
// dialects — but it has *shapes*: a turn that thinks between two tool calls, a
// turn cut short by max_tokens, a stream padded with pings, one that pauses,
// one that is declined. Each is a real transcript shape rather than a synthetic
// ideal, pinned here because every one of them reaches the agent loop as a
// different outcome and the loop has no other way to tell them apart.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
import { resolveProviderConfig } from "../../src/provider/presets.js";

type Shape = {
  name: string;
  /** SSE events, in order, exactly as the API frames them. */
  events: unknown[];
  /** Whether the transcript is terminated by message_stop. */
  terminated: boolean;
  expected: {
    content?: string;
    reasoning?: string;
    toolCalls?: { id: string; name: string; argumentsJson: string }[];
    finishReason: string;
    promptTokens?: number;
    completionTokens?: number;
    cacheHitTokens?: number;
  };
};

const start = (usage: Record<string, number>): unknown => ({ type: "message_start", message: { usage } });
const textBlock = (index: number, ...parts: string[]): unknown[] => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  ...parts.map((text) => ({ type: "content_block_delta", index, delta: { type: "text_delta", text } })),
  { type: "content_block_stop", index },
];
const stop = (reason: string, output = 1, extra: Record<string, unknown> = {}): unknown[] => [
  { type: "message_delta", delta: { stop_reason: reason, ...extra }, usage: { output_tokens: output } },
  { type: "message_stop" },
];

const SHAPES: Shape[] = [
  {
    name: "thinking interleaved between two tool calls",
    events: [
      start({ input_tokens: 30 }),
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "check both" } },
      // The signature closes a thinking block and carries no readable text.
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_a", name: "read_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' } },
      { type: "content_block_stop", index: 1 },
      { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_b", name: "read_file" } },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":"b.ts"}' } },
      { type: "content_block_stop", index: 2 },
      ...stop("tool_use", 12),
    ],
    terminated: true,
    expected: {
      content: "",
      reasoning: "check both",
      toolCalls: [
        { id: "toolu_a", name: "read_file", argumentsJson: '{"path":"a.ts"}' },
        { id: "toolu_b", name: "read_file", argumentsJson: '{"path":"b.ts"}' },
      ],
      finishReason: "tool_calls",
      completionTokens: 12,
    },
  },
  {
    name: "answer truncated by max_tokens",
    events: [start({ input_tokens: 10 }), ...textBlock(0, "half an ans"), ...stop("max_tokens", 16_000)],
    terminated: true,
    // "length" is what tells the loop the answer is incomplete; reporting it as
    // a normal stop would present a truncated reply as a finished one.
    expected: { content: "half an ans", finishReason: "length", completionTokens: 16_000 },
  },
  {
    name: "stream padded with pings and an empty-delta heartbeat",
    events: [
      start({ input_tokens: 5 }),
      { type: "ping" },
      ...textBlock(0, "ok"),
      { type: "ping" },
      { type: "message_delta", delta: {}, usage: {} },
      ...stop("end_turn", 2),
    ],
    terminated: true,
    expected: { content: "ok", finishReason: "stop", completionTokens: 2 },
  },
  {
    name: "server-tool turn that pauses instead of finishing",
    events: [start({ input_tokens: 8 }), ...textBlock(0, "searching"), ...stop("pause_turn", 4)],
    terminated: true,
    // Not an answer and not a tool call the loop can run: "other" ends the turn
    // rather than pretending either.
    expected: { content: "searching", finishReason: "other", completionTokens: 4 },
  },
  {
    name: "request declined by a safety classifier",
    events: [
      start({ input_tokens: 6 }),
      ...stop("refusal", 0, { stop_details: { type: "refusal", category: "cyber" } }),
    ],
    terminated: true,
    expected: { finishReason: "other", completionTokens: 0 },
  },
  {
    name: "cached prefix, so most of the prompt is a cache read",
    events: [
      start({ input_tokens: 120, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 300 }),
      ...textBlock(0, "hi"),
      ...stop("end_turn", 3),
    ],
    terminated: true,
    // 120 uncached + 9000 read + 300 written IS the prompt; the API reports the
    // first number alone and a naive mapping would report a 75x smaller prompt.
    expected: {
      content: "hi",
      finishReason: "stop",
      promptTokens: 9_420,
      cacheHitTokens: 9_000,
      completionTokens: 3,
    },
  },
  {
    name: "tool input split across three deltas mid-token",
    events: [
      start({ input_tokens: 4 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_x", name: "apply_patch" },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'th":"src/a' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '.ts"}' } },
      { type: "content_block_stop", index: 0 },
      ...stop("tool_use", 9),
    ],
    terminated: true,
    expected: {
      content: "",
      toolCalls: [{ id: "toolu_x", name: "apply_patch", argumentsJson: '{"path":"src/a.ts"}' }],
      finishReason: "tool_calls",
    },
  },
];

let server: Server;
let baseUrl: string;
let nextEvents: unknown[] = [];
let terminate = true;

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // A comment line and a named event field are both legal framing and must
      // be ignored rather than parsed as payloads.
      response.write(": heartbeat\n\n");
      for (const event of nextEvents) {
        response.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end(terminate ? "" : "event: content_block_stop\ndata: {}\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

function provider() {
  return createDeepSeekProvider(
    resolveProviderConfig({ provider: "anthropic", apiKey: "sk-ant-test", baseUrl, model: "claude-opus-5" }),
  );
}

describe("anthropic stream shapes", () => {
  it.each(SHAPES.map((shape) => [shape.name, shape] as const))("reads %s", async (_name, shape: Shape) => {
    nextEvents = shape.events;
    terminate = shape.terminated;
    const reasoningDeltas: string[] = [];

    const result = await provider().chatStream(
      { messages: [{ role: "user", content: "go" }] },
      () => {},
      (delta) => reasoningDeltas.push(delta),
    );

    if (shape.expected.content !== undefined) expect(result.content).toBe(shape.expected.content);
    expect(result.finishReason).toBe(shape.expected.finishReason);
    expect(result.toolCalls).toEqual(shape.expected.toolCalls ?? []);
    if (shape.expected.reasoning !== undefined) {
      expect(result.reasoningContent).toBe(shape.expected.reasoning);
      expect(reasoningDeltas.join("")).toBe(shape.expected.reasoning);
    }
    if (shape.expected.promptTokens !== undefined) expect(result.usage.promptTokens).toBe(shape.expected.promptTokens);
    if (shape.expected.completionTokens !== undefined) {
      expect(result.usage.completionTokens).toBe(shape.expected.completionTokens);
    }
    if (shape.expected.cacheHitTokens !== undefined) {
      expect(result.usage.cacheHitTokens).toBe(shape.expected.cacheHitTokens);
    }
  });

  it("says why a refusal came back empty rather than returning a blank turn", async () => {
    nextEvents = SHAPES.find((s) => s.name.includes("declined"))!.events;
    terminate = true;
    const result = await provider().chatStream({ messages: [{ role: "user", content: "go" }] }, () => {});
    expect(result.content).toContain("cyber");
  });

  it("refuses a stream that ends without message_stop instead of returning a partial answer", async () => {
    nextEvents = [{ type: "message_start", message: { usage: { input_tokens: 3 } } }, ...textBlock(0, "partial")];
    terminate = false;

    // A cut connection and a deliberate close look identical on the wire, so
    // the terminator is what separates "complete" from "truncated".
    await expect(provider().chatStream({ messages: [{ role: "user", content: "go" }] }, () => {})).rejects.toThrow(
      /ended before message_stop/,
    );
  });
});
