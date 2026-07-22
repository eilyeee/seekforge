import { describe, expect, it } from "vitest";
import { buildRequestBody, mapChatResponse, mapUsage } from "../../src/provider/mapping.js";
import { PROVIDER_PRESETS } from "../../src/provider/presets.js";

describe("provider compatibility matrix", () => {
  it.each(Object.entries(PROVIDER_PRESETS))("keeps %s request and accounting semantics explicit", (name, preset) => {
    const model = preset.models[0]!;
    const body = buildRequestBody(
      model,
      {
        messages: [{ role: "user", content: "use a tool" }],
        tools: [{ name: "inspect", description: "Inspect", parameters: { type: "object" } }],
      },
      true,
      { thinking: true, reasoningEffort: "high" },
      preset.capabilities,
    );

    expect(body).toMatchObject({ model, stream: true, stream_options: { include_usage: true } });
    expect(body.tools).toHaveLength(1);
    if (name === "deepseek") expect(body.thinking).toEqual({ type: "enabled", reasoning_effort: "high" });
    else expect(body).not.toHaveProperty("thinking");

    const usage = mapUsage(
      { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 6 },
      model,
      preset.capabilities,
    );
    if (name === "deepseek") {
      expect(usage.cacheHitTokens).toBe(6);
      expect(usage.costUsd).toBeGreaterThan(0);
    } else {
      expect(usage.cacheHitTokens).toBe(0);
      expect(usage.costUsd).toBe(0);
    }
  });

  it.each(Object.keys(PROVIDER_PRESETS))("maps OpenAI-compatible tool calls for %s", (name) => {
    const preset = PROVIDER_PRESETS[name]!;
    const response = mapChatResponse(
      {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [{ id: "call-1", type: "function", function: { name: "inspect", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      preset.models[0]!,
      preset.capabilities,
    );
    expect(response.toolCalls).toEqual([{ id: "call-1", name: "inspect", argumentsJson: "{}" }]);
    expect(response.finishReason).toBe("tool_calls");
  });
});
