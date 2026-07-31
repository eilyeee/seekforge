// Wire-dialect fixtures for OpenAI-compatible providers.
//
// Every provider below claims to speak the OpenAI chat-completions protocol,
// yet each spells parts of it differently. These fixtures pin the divergences
// SeekForge has to absorb so one normalized result comes out regardless of who
// produced the bytes. Each fixture is a real transcript shape, not a synthetic
// ideal: chunk splits, missing ids, and absent fields are the point.

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
import { mapChatResponse, mapUsage } from "../../src/provider/mapping.js";
import { resolveProviderConfig } from "../../src/provider/presets.js";

type Dialect = {
  /** Provider preset (or a plain OpenAI-compatible endpoint) this shape comes from. */
  name: string;
  preset?: string;
  /** SSE payloads, in order, exactly as the provider frames them. */
  chunks: unknown[];
  /** Whether the transcript is terminated by `data: [DONE]`. */
  done: boolean;
  expected: {
    content: string;
    reasoning?: string;
    toolCalls: { id?: string; name: string; argumentsJson: string }[];
    finishReason: string;
  };
};

const DIALECTS: Dialect[] = [
  {
    name: "deepseek: reasoning_content plus a single tool call",
    preset: "deepseek",
    chunks: [
      { choices: [{ delta: { reasoning_content: "weigh" } }] },
      { choices: [{ delta: { reasoning_content: " options" } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: "call_abc", type: "function", function: { name: "read_file" } }],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 9, completion_tokens: 4 } },
    ],
    done: true,
    expected: {
      content: "",
      reasoning: "weigh options",
      toolCalls: [{ id: "call_abc", name: "read_file", argumentsJson: '{"path":"a.ts"}' }],
      finishReason: "tool_calls",
    },
  },
  {
    name: "openrouter: `reasoning` instead of `reasoning_content`",
    preset: "openrouter",
    chunks: [
      { choices: [{ delta: { role: "assistant", reasoning: "think" } }] },
      { choices: [{ delta: { reasoning: "ing" } }] },
      { choices: [{ delta: { content: "done" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ],
    done: true,
    expected: { content: "done", reasoning: "thinking", toolCalls: [], finishReason: "stop" },
  },
  {
    name: "legacy: function_call finish reason",
    chunks: [
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_dir", arguments: "{}" } }] },
            finish_reason: "function_call",
          },
        ],
      },
    ],
    done: true,
    expected: {
      content: "",
      toolCalls: [{ id: "call_1", name: "list_dir", argumentsJson: "{}" }],
      finishReason: "tool_calls",
    },
  },
  {
    name: "ark/vllm: tool call without an index, stream ends without finish_reason",
    preset: "ark",
    chunks: [
      { choices: [{ delta: { tool_calls: [{ id: "call_x", function: { name: "search_text" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"pattern":"todo"}' } }] } }] },
    ],
    done: true,
    expected: {
      content: "",
      toolCalls: [{ id: "call_x", name: "search_text", argumentsJson: '{"pattern":"todo"}' }],
      finishReason: "tool_calls",
    },
  },
  {
    name: "azure-style: empty first choices array and keep-alive comments",
    chunks: [{ choices: [] }, { choices: [{ delta: { content: "hi" } }] }, { choices: [{ finish_reason: "stop" }] }],
    done: true,
    expected: { content: "hi", toolCalls: [], finishReason: "stop" },
  },
  {
    name: "ollama: no usage block at all, two parallel tool calls",
    preset: "ollama",
    chunks: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "one", arguments: "{}" } },
                { index: 1, id: "b", function: { name: "two", arguments: '{"k":1}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ],
    done: true,
    expected: {
      content: "",
      toolCalls: [
        { id: "a", name: "one", argumentsJson: "{}" },
        { id: "b", name: "two", argumentsJson: '{"k":1}' },
      ],
      finishReason: "tool_calls",
    },
  },
];

let server: Server;
let baseUrl: string;
let nextTranscript: { chunks: unknown[]; done: boolean } = { chunks: [], done: true };

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      // A real stream interleaves keep-alive comments and blank lines; both
      // must be ignored rather than parsed as payloads.
      response.write(": keep-alive\n\n");
      for (const chunk of nextTranscript.chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
      response.end(nextTranscript.done ? "data: [DONE]\n\n" : "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("provider wire dialects", () => {
  it.each(DIALECTS.map((dialect) => [dialect.name, dialect] as const))(
    "normalizes %s",
    async (_name, dialect: Dialect) => {
      nextTranscript = { chunks: dialect.chunks, done: dialect.done };
      const provider = createDeepSeekProvider(
        resolveProviderConfig({
          ...(dialect.preset ? { provider: dialect.preset } : {}),
          apiKey: "key",
          baseUrl,
          model: "test-model",
        }),
      );
      const reasoningDeltas: string[] = [];

      const result = await provider.chatStream(
        { messages: [{ role: "user", content: "go" }] },
        () => {},
        (delta) => reasoningDeltas.push(delta),
      );

      expect(result.content).toBe(dialect.expected.content);
      expect(result.finishReason).toBe(dialect.expected.finishReason);
      expect(result.toolCalls ?? []).toEqual(
        dialect.expected.toolCalls.map((call) => ({
          id: call.id ?? expect.any(String),
          name: call.name,
          argumentsJson: call.argumentsJson,
        })),
      );
      if (dialect.expected.reasoning !== undefined) {
        expect(result.reasoningContent).toBe(dialect.expected.reasoning);
        expect(reasoningDeltas.join("")).toBe(dialect.expected.reasoning);
      }
    },
  );
});

describe("provider stream termination", () => {
  it("refuses a stream that ends without [DONE] instead of returning a partial answer", async () => {
    nextTranscript = {
      chunks: [{ choices: [{ delta: { content: "partial" } }] }],
      done: false,
    };
    const provider = createDeepSeekProvider(resolveProviderConfig({ apiKey: "key", baseUrl, model: "test-model" }));

    // A cut connection and a deliberate close look identical on the wire, so
    // the strict terminator is what separates "complete" from "truncated".
    await expect(provider.chatStream({ messages: [{ role: "user", content: "go" }] }, () => {})).rejects.toThrow(
      /ended before \[DONE\]/,
    );
  });
});

describe("provider usage dialects", () => {
  it("reads OpenAI-style cached tokens, and prefers DeepSeek's field when both appear", () => {
    const capabilities = { thinking: false, cacheHitTokens: true, costAccounting: false, balance: false };
    expect(
      mapUsage(
        { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 40 } },
        "m",
        capabilities,
      ).cacheHitTokens,
    ).toBe(40);
    expect(
      mapUsage(
        {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 10,
          prompt_tokens_details: { cached_tokens: 40 },
        },
        "m",
        capabilities,
      ).cacheHitTokens,
    ).toBe(10);
    expect(() =>
      mapUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: -1 } }, "m", capabilities),
    ).toThrow(/cached_tokens/);
  });

  it("keeps cache-hit accounting off for providers whose preset disables it", () => {
    const usage = mapUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 40 } }, "m", {
      thinking: false,
      cacheHitTokens: false,
      costAccounting: false,
      balance: false,
    });
    expect(usage.cacheHitTokens).toBe(0);
    expect(usage.costUsd).toBe(0);
  });

  it("accepts `reasoning` on a non-streaming response body", () => {
    const response = mapChatResponse(
      { choices: [{ message: { content: "ok", reasoning: "because" }, finish_reason: "stop" }] },
      "test-model",
      { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
    );
    expect(response).toMatchObject({ content: "ok", reasoningContent: "because" });
  });
});
