import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import {
  buildRequestBody,
  mapChatResponse,
  mapFinishReason,
  mapUsage,
  MAX_PROVIDER_USAGE_TOKENS,
  ProviderProtocolError,
  toWireMessages,
  toWireTools,
} from "../../src/provider/mapping.js";
import {
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
} from "../../src/provider/protocol-limits.js";
import type { ProviderCapabilities } from "../../src/provider/types.js";

describe("toWireMessages", () => {
  it("maps assistant toolCalls to OpenAI-style tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "get_weather", argumentsJson: '{"city":"Tokyo"}' }],
      },
      { role: "tool", content: '{"temp": 21}', toolCallId: "call_1" },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
          },
        ],
      },
      { role: "tool", content: '{"temp": 21}', tool_call_id: "call_1" },
    ]);
  });

  it("omits tool_calls / tool_call_id when absent", () => {
    const wire = toWireMessages([{ role: "assistant", content: "hi" }]);
    expect(wire[0]).toEqual({ role: "assistant", content: "hi" });
    expect(wire[0]).not.toHaveProperty("tool_calls");
  });

  it("drops an assistant tool_call with no matching tool result (mid-turn crash/resume)", () => {
    // A history persisted between the assistant message and its tool results
    // (cancel/error/cap mid-turn) would otherwise 400 on resume.
    const wire = toWireMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "run", argumentsJson: "{}" }],
      },
    ]);
    expect(wire).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: "" },
    ]);
    expect(wire[1]).not.toHaveProperty("tool_calls");
  });

  it("keeps answered tool_calls and drops only the unanswered one in a partial turn", () => {
    const wire = toWireMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "run", argumentsJson: "{}" },
          { id: "call_2", name: "run", argumentsJson: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "call_1" },
    ]);
    expect(wire).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "run", arguments: "{}" } }],
      },
      { role: "tool", content: "ok", tool_call_id: "call_1" },
    ]);
  });

  it("drops an orphan tool result with no preceding assistant tool_call", () => {
    const wire = toWireMessages([
      { role: "user", content: "hi" },
      { role: "tool", content: "stray", toolCallId: "ghost" },
    ]);
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });

  it("pairs duplicate tool-call IDs within their assistant turn", () => {
    const wire = toWireMessages([
      {
        role: "assistant",
        content: "first",
        toolCalls: [{ id: "duplicate", name: "first_call", argumentsJson: "{}" }],
      },
      { role: "user", content: "interrupted" },
      {
        role: "assistant",
        content: "second",
        toolCalls: [{ id: "duplicate", name: "second_call", argumentsJson: "{}" }],
      },
      { role: "tool", content: "second result", toolCallId: "duplicate" },
    ]);

    expect(wire[0]).toEqual({ role: "assistant", content: "first" });
    expect(wire[0]).not.toHaveProperty("tool_calls");
    expect(wire[2]?.tool_calls?.[0]?.function.name).toBe("second_call");
    expect(wire[3]).toEqual({ role: "tool", content: "second result", tool_call_id: "duplicate" });
  });
});

describe("toWireTools", () => {
  it("wraps definitions in type:function envelopes", () => {
    const tools = toWireTools([{ name: "read_file", description: "Read a file.", parameters: { type: "object" } }]);
    expect(tools).toEqual([
      {
        type: "function",
        function: { name: "read_file", description: "Read a file.", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("buildRequestBody", () => {
  it("includes model, messages, optional fields, and stream_options when streaming", () => {
    const body = buildRequestBody(
      "deepseek-chat",
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "d", parameters: {} }],
        temperature: 0.2,
        maxTokens: 1024,
      },
      true,
    );
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(1024);
    expect(Array.isArray(body.tools)).toBe(true);
  });

  it("omits tools/temperature/max_tokens/stream_options when not set", () => {
    const body = buildRequestBody("deepseek-chat", { messages: [] }, false);
    expect(body).toEqual({ model: "deepseek-chat", messages: [], stream: false });
  });
});

describe("mapFinishReason", () => {
  it("maps known reasons and falls back to other", () => {
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("length")).toBe("length");
    expect(mapFinishReason("insufficient_system_resource")).toBe("other");
    expect(mapFinishReason(null)).toBe("other");
    expect(mapFinishReason(undefined)).toBe("other");
  });
});

describe("mapUsage", () => {
  it("maps DeepSeek usage fields including cache hits and computes cost", () => {
    const usage = mapUsage(
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_cache_hit_tokens: 600,
        prompt_cache_miss_tokens: 400,
      },
      "deepseek-chat",
    );
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(500);
    expect(usage.cacheHitTokens).toBe(600);
    expect(usage.costUsd).toBeCloseTo((400 * 0.28 + 600 * 0.028 + 500 * 0.42) / 1_000_000, 12);
  });

  it("defaults cacheHitTokens to 0 when absent and tolerates missing usage", () => {
    expect(mapUsage({ prompt_tokens: 10, completion_tokens: 5 }, "deepseek-chat").cacheHitTokens).toBe(0);
    expect(mapUsage(undefined, "deepseek-chat")).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cacheHitTokens: 0,
      costUsd: 0,
    });
  });

  it.each([
    ["prompt_tokens", Number.POSITIVE_INFINITY],
    ["completion_tokens", -1],
    ["prompt_cache_hit_tokens", 2.9],
    ["prompt_cache_miss_tokens", Number.MAX_SAFE_INTEGER + 1],
    ["prompt_tokens", MAX_PROVIDER_USAGE_TOKENS + 1],
  ] as const)("rejects invalid usage.%s values", (field, value) => {
    expect(() => mapUsage({ [field]: value }, "deepseek-chat")).toThrow(ProviderProtocolError);
  });

  it("accepts the usage protocol ceiling", () => {
    expect(mapUsage({ prompt_tokens: MAX_PROVIDER_USAGE_TOKENS }, "deepseek-chat").promptTokens).toBe(
      MAX_PROVIDER_USAGE_TOKENS,
    );
  });

  it("validates cache token fields even when cache-hit accounting is disabled", () => {
    expect(() =>
      mapUsage({ prompt_cache_hit_tokens: Number.NaN }, "ark-model", {
        thinking: false,
        cacheHitTokens: false,
        costAccounting: false,
        balance: false,
      }),
    ).toThrow(ProviderProtocolError);
  });

  it("clamps cache-hit tokens to prompt tokens", () => {
    expect(mapUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 30 }, "deepseek-chat").cacheHitTokens).toBe(10);
  });
});

describe("mapChatResponse", () => {
  it("maps a tool-calling completion", () => {
    const response = mapChatResponse(
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "read_file", arguments: '{"path":"a.txt"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 10 },
      },
      "deepseek-chat",
    );
    expect(response.content).toBe("");
    expect(response.finishReason).toBe("tool_calls");
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' }]);
    expect(response.usage.promptTokens).toBe(50);
  });

  it("maps a plain text completion", () => {
    const response = mapChatResponse(
      {
        choices: [{ message: { content: "Hello!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      },
      "deepseek-chat",
    );
    expect(response.content).toBe("Hello!");
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe("stop");
  });

  it("rejects a successful response with an error or no choices", () => {
    expect(() => mapChatResponse({ error: { message: "tenant denied" } }, "deepseek-chat")).toThrow(
      /protocol error.*tenant denied/i,
    );
    expect(() => mapChatResponse({}, "deepseek-chat")).toThrow(/no choices/i);
    expect(() => mapChatResponse({ choices: [] }, "deepseek-chat")).toThrow(/no choices/i);
  });

  it("rejects valid JSON non-objects but tolerates malformed tool calls", () => {
    expect(() => mapChatResponse(null, "deepseek-chat")).toThrow(/must be an object/i);
    const response = mapChatResponse(
      {
        choices: [{ message: { content: "ok", tool_calls: [null, 42] as never } }],
      },
      "deepseek-chat",
    );
    expect(response.content).toBe("ok");
    expect(response.toolCalls).toEqual([]);
  });
});

describe("V4 thinking mode", () => {
  it("attaches thinking only for deepseek-v4 models", async () => {
    const { buildRequestBody } = await import("../../src/provider/mapping.js");
    const req = { messages: [{ role: "user" as const, content: "hi" }] };
    const v4 = buildRequestBody("deepseek-v4-pro", req, false, { thinking: true, reasoningEffort: "max" });
    expect(v4.thinking).toEqual({ type: "enabled", reasoning_effort: "max" });
    const off = buildRequestBody("deepseek-v4-flash", req, false, { thinking: false });
    expect(off.thinking).toEqual({ type: "disabled" });
    const legacy = buildRequestBody("deepseek-chat", req, false, { thinking: true });
    expect(legacy.thinking).toBeUndefined();
    const unset = buildRequestBody("deepseek-v4-pro", req, false, {});
    expect(unset.thinking).toBeUndefined();
  });

  it("maps reasoning_content from responses", async () => {
    const { mapChatResponse } = await import("../../src/provider/mapping.js");
    const res = mapChatResponse(
      { choices: [{ message: { content: "answer", reasoning_content: "let me think" }, finish_reason: "stop" }] },
      "deepseek-v4-pro",
    );
    expect(res.reasoningContent).toBe("let me think");
    expect(res.content).toBe("answer");
    const none = mapChatResponse(
      { choices: [{ message: { content: "x" }, finish_reason: "stop" }] },
      "deepseek-v4-pro",
    );
    expect(none.reasoningContent).toBeUndefined();
  });
});

describe("provider capabilities gating", () => {
  const req = { messages: [{ role: "user" as const, content: "hi" }] };

  it("omits the thinking body for a v4 model when capabilities.thinking is false (Ark)", () => {
    const body = buildRequestBody(
      "deepseek-v4-flash",
      req,
      false,
      { thinking: true },
      { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
    );
    expect(body.thinking).toBeUndefined();
    expect(body).not.toHaveProperty("thinking");
  });

  it("still attaches thinking for a v4 model when capabilities is unset (default unchanged)", () => {
    const body = buildRequestBody("deepseek-v4-flash", req, false, { thinking: true });
    expect(body.thinking).toEqual({ type: "enabled" });
  });

  it("still attaches thinking when capabilities.thinking is true", () => {
    const body = buildRequestBody(
      "deepseek-v4-pro",
      req,
      false,
      { thinking: true, reasoningEffort: "max" },
      { thinking: true, cacheHitTokens: true, costAccounting: true, balance: true },
    );
    expect(body.thinking).toEqual({ type: "enabled", reasoning_effort: "max" });
  });

  it("reports costUsd: 0 when capabilities.costAccounting is false", () => {
    const usage = mapUsage(
      { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600 },
      "deepseek-chat",
      { thinking: false, cacheHitTokens: true, costAccounting: false, balance: false },
    );
    expect(usage.costUsd).toBe(0);
    // Other fields still mapped normally.
    expect(usage.promptTokens).toBe(1000);
    expect(usage.completionTokens).toBe(500);
    expect(usage.cacheHitTokens).toBe(600);
  });

  it("reports cacheHitTokens: 0 when capabilities.cacheHitTokens is false", () => {
    const usage = mapUsage(
      { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600 },
      "deepseek-chat",
      { thinking: false, cacheHitTokens: false, costAccounting: true, balance: false },
    );
    expect(usage.cacheHitTokens).toBe(0);
  });

  it("mapUsage default (no capabilities) is unchanged", () => {
    const usage = mapUsage(
      { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
      "deepseek-chat",
    );
    expect(usage.cacheHitTokens).toBe(600);
    expect(usage.costUsd).toBeCloseTo((400 * 0.28 + 600 * 0.028 + 500 * 0.42) / 1_000_000, 12);
  });
});

describe("non-streaming response limits", () => {
  const responseWith = (message: Record<string, unknown>) => ({
    choices: [{ message, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

  it("rejects oversized content", () => {
    expect(() => mapChatResponse(responseWith({ content: "x".repeat(MAX_SSE_CONTENT_CHARS + 1) }), "m")).toThrow(
      ProviderProtocolError,
    );
  });

  it("rejects oversized tool arguments", () => {
    expect(() =>
      mapChatResponse(
        responseWith({
          content: "",
          tool_calls: [
            { id: "c1", function: { name: "tool", arguments: "x".repeat(MAX_SSE_TOOL_ARGUMENT_CHARS + 1) } },
          ],
        }),
        "m",
      ),
    ).toThrow(ProviderProtocolError);
  });

  it("rejects too many tool calls", () => {
    const toolCalls = Array.from({ length: MAX_SSE_TOOL_CALLS + 1 }, (_, index) => ({
      id: `c${index}`,
      function: { name: "tool", arguments: "{}" },
    }));
    expect(() => mapChatResponse(responseWith({ content: "", tool_calls: toolCalls }), "m")).toThrow(
      ProviderProtocolError,
    );
  });
});

describe("user-supplied modelPricing (cost on non-DeepSeek providers)", () => {
  // Example placeholder rates (NOT real prices) for an Ark model id.
  const arkCaps = { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false };
  const pricing = {
    "ark-model-x": { inputCacheMissPer1M: 2, inputCacheHitPer1M: 0.5, outputPer1M: 6 },
  };

  it("computes a real cost for a priced model even when costAccounting is false", () => {
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500 }, "ark-model-x", arkCaps, pricing);
    // cacheHitTokens is off for this provider, so all 1000 prompt tokens are miss.
    expect(usage.costUsd).toBeCloseTo((1000 * 2 + 500 * 6) / 1_000_000, 12);
    expect(usage.costUsd).toBeGreaterThan(0);
  });

  it("stays 0 for an unpriced model on a costAccounting:false provider", () => {
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500 }, "ark-model-unpriced", arkCaps, pricing);
    expect(usage.costUsd).toBe(0);
  });

  it("leaves the DeepSeek default (no override, costAccounting true) unchanged", () => {
    const withPricing = mapUsage(
      { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 },
      "deepseek-chat",
      undefined,
      pricing,
    );
    // deepseek-chat is not in the override table → built-in pricing, identical to no override.
    expect(withPricing.costUsd).toBeCloseTo((400 * 0.28 + 600 * 0.028 + 500 * 0.42) / 1_000_000, 12);
  });

  it("mapChatResponse threads the override into the mapped usage", () => {
    const res = mapChatResponse(
      {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
      },
      "ark-model-x",
      arkCaps,
      pricing,
    );
    expect(res.usage.costUsd).toBeCloseTo((1000 * 2 + 500 * 6) / 1_000_000, 12);
  });
});

describe("a cost the endpoint reported itself", () => {
  const routerCaps: ProviderCapabilities = {
    thinking: false,
    cacheHitTokens: true,
    costAccounting: false,
    balance: false,
    usageCost: true,
  };

  it("uses the charge the response states, where no table could apply", () => {
    // 400 models from a dozen vendors, repriced continuously: this endpoint is
    // the only thing that knows, and it says so on every request.
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123 }, "any/model", routerCaps);
    expect(usage.costUsd).toBe(0.0123);
  });

  it("reads cache reads and writes reported beside it", () => {
    const usage = mapUsage(
      {
        prompt_tokens: 1000,
        completion_tokens: 500,
        prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
        cost: 0.5,
      },
      "any/model",
      routerCaps,
    );
    expect(usage.cacheHitTokens).toBe(600);
    expect(usage.cacheWriteTokens).toBe(100);
  });

  it("falls back to the table rather than trusting a fumbled number", () => {
    for (const cost of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e9, "0.5" as unknown as number]) {
      const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500, cost }, "any/model", routerCaps);
      expect(usage.costUsd).toBe(0);
    }
  });

  it("still lets a user's own modelPricing override the bill", () => {
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500, cost: 99 }, "any/model", routerCaps, {
      "any/model": { inputCacheMissPer1M: 2, inputCacheHitPer1M: 0.5, outputPer1M: 6 },
    });
    expect(usage.costUsd).toBeCloseTo((1000 * 2 + 500 * 6) / 1_000_000, 12);
  });

  it("is ignored by a provider that does not report one", () => {
    // The same field arriving from an endpoint that never promised it must not
    // silently become the cost.
    const usage = mapUsage({ prompt_tokens: 1000, completion_tokens: 500, cost: 99 }, "deepseek-v4-flash", undefined);
    expect(usage.costUsd).toBeLessThan(1);
  });
});

describe("images on a protocol that cannot carry them", () => {
  it("says the image was omitted instead of dropping it silently", () => {
    // A model asked about a screenshot it never received answers confidently
    // about nothing; the note is the smallest honest substitute.
    const wire = toWireMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "browser_screenshot", argumentsJson: "{}" }] },
      {
        role: "tool",
        content: '{"path":"shot.png"}',
        toolCallId: "c1",
        images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      },
    ]);
    const result = wire.find((m) => m.role === "tool");
    expect(result?.content).toContain('{"path":"shot.png"}');
    expect(result?.content).toContain("1 image omitted");
  });

  it("leaves a message without images byte-for-byte unchanged", () => {
    const [wire] = toWireMessages([{ role: "user", content: "plain" }]);
    expect(wire).toEqual({ role: "user", content: "plain" });
  });
});

describe("images on a protocol that can carry them", () => {
  const seeing: ProviderCapabilities = {
    thinking: false,
    cacheHitTokens: false,
    costAccounting: false,
    balance: false,
    images: true,
  };

  it("hands a tool result's image over as a user turn after the tool block", () => {
    // This protocol takes image parts on a user message and not on a tool
    // message, so the screenshot cannot ride inside the result it answers.
    const wire = toWireMessages(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "browser_screenshot", argumentsJson: "{}" }] },
        {
          role: "tool",
          content: '{"path":"shot.png"}',
          toolCallId: "c1",
          images: [{ mediaType: "image/png", dataBase64: "AAAA", label: "browser screenshot" }],
        },
      ],
      seeing,
    );
    expect(wire.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    // The tool result keeps its own text and gains no note about an omission.
    expect(wire[1]?.content).toBe('{"path":"shot.png"}');
    expect(wire[2]?.content).toEqual([
      { type: "text", text: "Image produced by the tool call(s) above: browser screenshot." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  it("keeps a run of parallel tool results contiguous, with one user turn after it", () => {
    // A tool message must follow the assistant turn that called it with nothing
    // in between, so two results cannot each be followed by their own image.
    const wire = toWireMessages(
      [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "browser_screenshot", argumentsJson: "{}" },
            { id: "c2", name: "browser_screenshot", argumentsJson: "{}" },
          ],
        },
        { role: "tool", content: "a", toolCallId: "c1", images: [{ mediaType: "image/png", dataBase64: "AAAA" }] },
        { role: "tool", content: "b", toolCallId: "c2", images: [{ mediaType: "image/png", dataBase64: "BBBB" }] },
      ],
      seeing,
    );
    expect(wire.map((m) => m.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(wire[3]?.content).toEqual([
      { type: "text", text: "2 images produced by the tool call(s) above." },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } },
    ]);
  });

  it("puts a user's own image in that user message, text first", () => {
    const wire = toWireMessages(
      [{ role: "user", content: "what is wrong here", images: [{ mediaType: "image/jpeg", dataBase64: "BBBB" }] }],
      seeing,
    );
    expect(wire).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is wrong here" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } },
        ],
      },
    ]);
  });

  it("still notes an omission for a role this protocol cannot attach to", () => {
    // Nothing produces such a message today; this is what keeps a future one
    // from being a 400 in the middle of a run.
    const [wire] = toWireMessages(
      [{ role: "assistant", content: "here", images: [{ mediaType: "image/png", dataBase64: "AAAA" }] }],
      seeing,
    );
    expect(wire?.content).toContain("1 image omitted");
  });

  it("leaves an image-free conversation byte-for-byte unchanged", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", argumentsJson: "{}" }] },
      { role: "tool", content: "r", toolCallId: "c1" },
    ];
    expect(toWireMessages(messages, seeing)).toEqual(toWireMessages(messages));
  });
});
