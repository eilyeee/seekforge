import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@seekforge/shared";
import {
  buildRequestBody,
  mapChatResponse,
  mapFinishReason,
  mapUsage,
  toWireMessages,
  toWireTools,
} from "../../src/provider/mapping.js";

describe("toWireMessages", () => {
  it("maps assistant toolCalls to OpenAI-style tool_calls", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "get_weather", argumentsJson: '{"city":"Tokyo"}' },
        ],
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
});

describe("toWireTools", () => {
  it("wraps definitions in type:function envelopes", () => {
    const tools = toWireTools([
      { name: "read_file", description: "Read a file.", parameters: { type: "object" } },
    ]);
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
    expect(usage.costUsd).toBeCloseTo(
      (400 * 0.28 + 600 * 0.028 + 500 * 0.42) / 1_000_000,
      12,
    );
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
    expect(response.toolCalls).toEqual([
      { id: "call_1", name: "read_file", argumentsJson: '{"path":"a.txt"}' },
    ]);
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

  it("tolerates an empty choices array", () => {
    const response = mapChatResponse({ choices: [] }, "deepseek-chat");
    expect(response.content).toBe("");
    expect(response.finishReason).toBe("other");
    expect(response.usage.costUsd).toBe(0);
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
    const none = mapChatResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, "deepseek-v4-pro");
    expect(none.reasoningContent).toBeUndefined();
  });
});
