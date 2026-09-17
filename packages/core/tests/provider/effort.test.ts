import { describe, expect, it } from "vitest";
import { REASONING_EFFORTS } from "@seekforge/shared";
import { openAiCompatibleEffort } from "../../src/provider/effort.js";
import { buildRequestBody } from "../../src/provider/mapping.js";
import { PROVIDER_PRESETS } from "../../src/provider/presets.js";

const req = { messages: [{ role: "user" as const, content: "hi" }] };

describe("OpenAI reasoning_effort", () => {
  const openai = PROVIDER_PRESETS["openai"]!.capabilities;

  it.each([
    ["gpt-5.6-sol", ["low", "medium", "high", "max"]],
    ["gpt-5.6-luna", ["low", "medium", "high", "max"]],
    ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.4-mini", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.2", ["low", "medium", "high", "xhigh"]],
    ["gpt-5.1", ["low", "medium", "high", "high"]],
    ["gpt-5-mini", ["low", "medium", "high", "high"]],
  ])("maps every level onto what %s accepts", (model, expected) => {
    const sent = REASONING_EFFORTS.map(
      (reasoningEffort) => buildRequestBody(model, req, false, { reasoningEffort }, openai).reasoning_effort,
    );
    expect(sent).toEqual(expected);
  });

  it.each(["gpt-4.1", "gpt-4o", "gpt-5.5-pro", "o1-mini", "my-finetune"])(
    "sends no effort to %s, whose accepted levels are unknown",
    (model) => {
      const body = buildRequestBody(model, req, false, { thinking: true, reasoningEffort: "high" }, openai);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("thinking");
    },
  );

  it("sends no effort when thinking was asked to be off, and nothing when no level was asked for", () => {
    expect(
      buildRequestBody("gpt-5.6-sol", req, false, { thinking: false, reasoningEffort: "low" }, openai),
    ).not.toHaveProperty("reasoning_effort");
    const plain = buildRequestBody("gpt-5.6-sol", req, false, { thinking: true }, openai);
    expect(Object.keys(plain).sort()).toEqual(["messages", "model", "stream"]);
  });
});

describe("OpenRouter reasoning.effort", () => {
  const openrouter = PROVIDER_PRESETS["openrouter"]!.capabilities;

  it("sends the router's own field for any model, with max as its top level", () => {
    const sent = REASONING_EFFORTS.map(
      (reasoningEffort) =>
        buildRequestBody("deepseek/deepseek-v4-pro", req, false, { reasoningEffort }, openrouter).reasoning,
    );
    expect(sent).toEqual([{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }]);
    expect(openAiCompatibleEffort("openrouter", "anything/at-all", "low")).toEqual({ reasoning: { effort: "low" } });
  });
});

describe("endpoints without a known effort parameter", () => {
  it.each(["ark", "ollama"])("%s sends no effort field", (name) => {
    const preset = PROVIDER_PRESETS[name]!;
    const body = buildRequestBody(preset.models[0]!, req, false, { reasoningEffort: "max" }, preset.capabilities);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body).not.toHaveProperty("reasoning");
    expect(body).not.toHaveProperty("thinking");
  });

  it("a DeepSeek request with no effort and no thinking choice is unchanged", () => {
    const body = buildRequestBody("deepseek-v4-flash", req, true, {});
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
        stream_options: { include_usage: true },
      }),
    );
  });
});
