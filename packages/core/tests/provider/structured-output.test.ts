import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider, wrapProviderWithCache } from "../../src/provider/index.js";
import { buildRequestBody } from "../../src/provider/mapping.js";
import { PROVIDER_PRESETS, resolveProviderConfig } from "../../src/provider/presets.js";
import { anthropicProtocol } from "../../src/provider/protocols/anthropic.js";
import { structuredOutputFor } from "../../src/provider/structured-output.js";
import type { ChatProvider, ChatRequest, ResponseFormat } from "../../src/provider/types.js";

const schema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
};
const responseFormat: ResponseFormat = { type: "json_schema", name: "review", schema };
const req: ChatRequest = { messages: [{ role: "user", content: "review this, answer in json" }], responseFormat };

describe("structured output on the OpenAI-compatible protocol", () => {
  it("sends a strict json_schema format where the endpoint enforces one", () => {
    const body = buildRequestBody("gpt-5.6-sol", req, false, {}, PROVIDER_PRESETS["openai"]!.capabilities);
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "review", schema, strict: true },
    });
    const loose = buildRequestBody(
      "gpt-5.5",
      { ...req, responseFormat: { ...responseFormat, strict: false } },
      false,
      {},
      PROVIDER_PRESETS["openai"]!.capabilities,
    );
    expect(loose.response_format).toMatchObject({ json_schema: { strict: false } });
  });

  it("asks DeepSeek for plain JSON, which is all it can promise", () => {
    expect(buildRequestBody("deepseek-v4-flash", req, false).response_format).toEqual({ type: "json_object" });
    expect(buildRequestBody("deepseek-flash", req, true, {}, PROVIDER_PRESETS["deepseek"]!.capabilities)).toMatchObject(
      { response_format: { type: "json_object" } },
    );
  });

  it.each([
    ["openai", "gpt-3.5-turbo"],
    ["ark", "doubao-seed-2.0-code"],
    ["ollama", "llama3.1"],
    ["openrouter", "openai/gpt-5.6-sol"],
  ])("sends no format where %s cannot honor one for %s", (preset, model) => {
    const body = buildRequestBody(model, req, false, {}, PROVIDER_PRESETS[preset]!.capabilities);
    expect(body).not.toHaveProperty("response_format");
  });

  it("leaves a request without a format unchanged", () => {
    const { responseFormat: _omit, ...plain } = req;
    const body = buildRequestBody("gpt-5.6-sol", plain, false, {}, PROVIDER_PRESETS["openai"]!.capabilities);
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
  });
});

describe("structured output on the Anthropic protocol", () => {
  const capabilities = PROVIDER_PRESETS["anthropic"]!.capabilities;

  it("uses the native output format, beside an effort level", () => {
    const body = anthropicProtocol.buildBody(
      "claude-opus-5",
      req,
      false,
      { thinking: true, reasoningEffort: "low" },
      capabilities,
    );
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema }, effort: "low" });
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("keeps the format when the endpoint takes no thinking controls, and skips models without the feature", () => {
    const noThinking = anthropicProtocol.buildBody(
      "claude-haiku-4-5",
      req,
      false,
      { reasoningEffort: "max" },
      {
        ...capabilities,
        thinking: false,
      },
    );
    expect(noThinking.output_config).toEqual({ format: { type: "json_schema", schema } });
    for (const model of ["claude-opus-4-1", "claude-3-7-sonnet-latest", "claude-sonnet-4-20250514"]) {
      expect(anthropicProtocol.buildBody(model, req, false, {}, capabilities)).not.toHaveProperty("output_config");
    }
    expect(structuredOutputFor("anthropic", capabilities, "claude-sonnet-4-5-20250929")).toBe("json_schema");
  });
});

describe("the provider says what it can promise", () => {
  it.each([
    ["deepseek", "deepseek-v4-pro", "json_object"],
    ["anthropic", "claude-sonnet-5", "json_schema"],
    ["openai", "gpt-5.4-mini", "json_schema"],
    ["openai", "gpt-3.5-turbo", undefined],
    ["ark", "doubao-seed-2.0-pro", undefined],
  ] as const)("%s / %s → %s", (provider, model, expected) => {
    const built = createDeepSeekProvider(resolveProviderConfig({ provider, apiKey: "k", model }));
    expect(built.structuredOutput).toBe(expected);
  });

  it("keeps the answer, and keys the response cache on the format, through the cache wrapper", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-structured-cache-"));
    try {
      const chat = vi.fn(async (request: ChatRequest) => ({
        content: request.responseFormat ? '{"verdict":"ok"}' : "ok",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 },
        finishReason: "stop" as const,
      }));
      const inner: ChatProvider = {
        model: "m",
        cacheIdentity: "id",
        structuredOutput: "json_schema",
        chat,
        chatStream: async () => {
          throw new Error("unused");
        },
      };
      const cached = wrapProviderWithCache(inner, dir);
      expect(cached.structuredOutput).toBe("json_schema");
      const { responseFormat: _omit, ...plain } = req;
      expect((await cached.chat(plain)).content).toBe("ok");
      expect((await cached.chat(req)).content).toBe('{"verdict":"ok"}');
      expect((await cached.chat(req)).content).toBe('{"verdict":"ok"}');
      expect(chat).toHaveBeenCalledTimes(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
