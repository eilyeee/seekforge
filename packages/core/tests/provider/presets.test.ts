import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, resolveProviderPreset, resolveProviderConfig } from "../../src/provider/presets.js";
import { DEEPSEEK_CAPABILITIES } from "../../src/provider/types.js";
import { DEFAULT_BASE_URL } from "../../src/provider/constants.js";

describe("resolveProviderPreset", () => {
  it("returns the Ark preset (thinking disabled) for 'ark', case-insensitively", () => {
    const lower = resolveProviderPreset("ark");
    expect(lower).toBeDefined();
    expect(lower?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(lower?.capabilities).toEqual({
      thinking: false,
      cacheHitTokens: false,
      costAccounting: false,
      balance: false,
    });
    // Case-insensitive lookup.
    expect(resolveProviderPreset("ARK")).toBe(lower);
    expect(resolveProviderPreset("Ark")).toBe(lower);
    // Ark exposes its own 11-model catalog.
    expect(lower?.models).toEqual([
      "doubao-seed-2.0-code",
      "doubao-seed-2.0-pro",
      "doubao-seed-2.0-lite",
      "doubao-seed-2.0-mini",
      "glm-5.2",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "minimax-m3",
      "minimax-m2.7",
    ]);
  });

  it("returns the DeepSeek preset with full capabilities for 'deepseek'", () => {
    const preset = resolveProviderPreset("deepseek");
    expect(preset).toBeDefined();
    expect(preset?.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(preset?.capabilities).toEqual(DEEPSEEK_CAPABILITIES);
    expect(preset?.capabilities.thinking).toBe(true);
    // DeepSeek exposes only the non-deprecated V4 models.
    expect(preset?.models).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
  });

  it.each([
    ["openai", "https://api.openai.com/v1", ["gpt-4o", "gpt-4o-mini", "o3-mini"]],
    ["ollama", "http://localhost:11434/v1", ["llama3.1", "qwen2.5-coder", "deepseek-r1"]],
    [
      "openrouter",
      "https://openrouter.ai/api/v1",
      ["anthropic/claude-3.5-sonnet", "openai/gpt-4o", "deepseek/deepseek-chat"],
    ],
  ] as const)(
    "returns the %s OpenAI-compatible preset (all capabilities disabled), case-insensitively",
    (name, baseUrl, models) => {
      const preset = resolveProviderPreset(name);
      expect(preset).toBeDefined();
      expect(preset?.baseUrl).toBe(baseUrl);
      expect(preset?.capabilities).toEqual({
        thinking: false,
        cacheHitTokens: false,
        costAccounting: false,
        balance: false,
      });
      expect(preset?.models).toEqual(models);
      expect(preset?.models.length).toBeGreaterThan(0);
      // Case-insensitive lookup returns the same object.
      expect(resolveProviderPreset(name.toUpperCase())).toBe(preset);
    },
  );

  it("returns undefined for an unknown or missing preset name", () => {
    expect(resolveProviderPreset("nope")).toBeUndefined();
    expect(resolveProviderPreset("")).toBeUndefined();
    expect(resolveProviderPreset(undefined)).toBeUndefined();
  });

  it("exposes all presets on PROVIDER_PRESETS", () => {
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual(["ark", "deepseek", "ollama", "openai", "openrouter"]);
  });
});

describe("resolveProviderConfig", () => {
  it("folds the ark preset: ark baseUrl + capabilities with thinking disabled", () => {
    const config = resolveProviderConfig({ provider: "ark", apiKey: "k", model: "glm-5.2" });
    expect(config.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/plan/v3");
    expect(config.capabilities).toEqual({
      thinking: false,
      cacheHitTokens: false,
      costAccounting: false,
      balance: false,
    });
    expect(config.capabilities?.thinking).toBe(false);
    expect(config.model).toBe("glm-5.2");
    expect(config.apiKey).toBe("k");
  });

  it("lets an explicit baseUrl override the preset's", () => {
    const config = resolveProviderConfig({
      provider: "ark",
      apiKey: "k",
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(config.baseUrl).toBe("https://proxy.example.com/v1");
    // Capabilities still come from the preset even when baseUrl is overridden.
    expect(config.capabilities?.thinking).toBe(false);
  });

  it("no provider → no capabilities and baseUrl passthrough (DeepSeek default preserved)", () => {
    const withUrl = resolveProviderConfig({ apiKey: "k", baseUrl: "https://custom/v1" });
    expect(withUrl.capabilities).toBeUndefined();
    expect(withUrl.baseUrl).toBe("https://custom/v1");

    const bare = resolveProviderConfig({ apiKey: "k" });
    expect(bare.capabilities).toBeUndefined();
    expect(bare.baseUrl).toBeUndefined();
    // Only apiKey survives — nothing else was provided.
    expect(Object.keys(bare)).toEqual(["apiKey"]);
  });

  it("passes optional fields through only when defined", () => {
    const config = resolveProviderConfig({
      apiKey: "k",
      model: "deepseek-v4-flash",
      thinking: false,
      reasoningEffort: "max",
      streamIdleTimeoutMs: 5000,
      fallbackModel: "deepseek-v4-pro",
    });
    expect(config.thinking).toBe(false);
    expect(config.reasoningEffort).toBe("max");
    expect(config.streamIdleTimeoutMs).toBe(5000);
    expect(config.fallbackModel).toBe("deepseek-v4-pro");
    expect(config.capabilities).toBeUndefined();
  });
});
