import { describe, expect, it } from "vitest";
import { PROVIDER_PRESETS, resolveProviderPreset, resolveProviderConfig } from "../../src/provider/presets.js";
import { DEEPSEEK_CAPABILITIES } from "../../src/provider/types.js";
import { DEFAULT_BASE_URL, MODEL_PRICING } from "../../src/provider/constants.js";

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
    // These presets share the DeepSeek-only exclusions (no thinking body, no
    // /user/balance) and differ where the endpoint itself differs: whether it
    // takes an image, whether it reports cached input, and who can answer what
    // a request cost.
    [
      "openai",
      "https://api.openai.com/v1",
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
      // Its own published price list ships with SeekForge, and it reports
      // cached input under prompt_tokens_details.
      { thinking: false, cacheHitTokens: true, costAccounting: true, balance: false, images: true },
    ],
    [
      "ollama",
      "http://localhost:11434/v1",
      ["llama3.1", "qwen2.5-coder", "deepseek-r1"],
      // Local models: no price to know, no cache to report, no eyes by default.
      { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
    ],
    [
      "openrouter",
      "https://openrouter.ai/api/v1",
      ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro"],
      // No table could track its catalog; it states the charge per request.
      {
        thinking: false,
        cacheHitTokens: true,
        costAccounting: false,
        balance: false,
        images: true,
        usageCost: true,
      },
    ],
  ] as const)("returns the %s OpenAI-compatible preset, case-insensitively", (name, baseUrl, models, capabilities) => {
    const preset = resolveProviderPreset(name);
    expect(preset).toBeDefined();
    expect(preset?.baseUrl).toBe(baseUrl);
    expect(preset?.capabilities).toEqual(capabilities);
    expect(preset?.models).toEqual(models);
    expect(preset?.models.length).toBeGreaterThan(0);
    // Case-insensitive lookup returns the same object.
    expect(resolveProviderPreset(name.toUpperCase())).toBe(preset);
  });

  it("prices every model it offers, or offers none it cannot price", () => {
    // A catalog entry with no built-in rate on a costAccounting preset reports
    // "unknown" — correct, but a picker should not lead with such a model.
    for (const model of resolveProviderPreset("openai")?.models ?? []) {
      expect(MODEL_PRICING[model], model).toBeDefined();
    }
  });

  it("leaves images off where the catalog is mixed or has no vision model", () => {
    // Turning this on for a model that cannot read an image fails the request
    // rather than degrading, so a mixed catalog answers no and defers to the
    // user's `inlineImages`.
    expect(resolveProviderPreset("ark")?.capabilities.images).toBeUndefined();
    expect(resolveProviderPreset("ollama")?.capabilities.images).toBeUndefined();
    expect(resolveProviderPreset("deepseek")?.capabilities.images).toBeUndefined();
  });

  it("returns undefined for an unknown or missing preset name", () => {
    expect(resolveProviderPreset("nope")).toBeUndefined();
    expect(resolveProviderPreset("")).toBeUndefined();
    expect(resolveProviderPreset(undefined)).toBeUndefined();
  });

  it("exposes all presets on PROVIDER_PRESETS", () => {
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual([
      "anthropic",
      "ark",
      "deepseek",
      "ollama",
      "openai",
      "openrouter",
    ]);
  });

  it("only the anthropic preset speaks a non-OpenAI protocol", () => {
    // Every other preset predates a second wire protocol; leaving the field
    // unset is what keeps their requests byte-for-byte unchanged.
    for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
      expect(preset.protocol, name).toBe(name === "anthropic" ? "anthropic" : undefined);
    }
  });

  it("returns the anthropic preset with cache and cost accounting on", () => {
    const preset = resolveProviderPreset("anthropic");
    expect(preset?.baseUrl).toBe("https://api.anthropic.com/v1");
    // Claude reports cache reads and has a published price list, so — unlike
    // the OpenAI-compatible non-DeepSeek presets — neither is switched off.
    expect(preset?.capabilities).toEqual({
      thinking: true,
      cacheHitTokens: true,
      costAccounting: true,
      balance: false,
      images: true,
    });
    expect(preset?.models).toContain("claude-opus-5");
    expect(resolveProviderPreset("Anthropic")).toBe(preset);
  });
});

describe("resolveProviderConfig", () => {
  it("folds the ark preset: ark baseUrl + capabilities with thinking disabled", () => {
    const config = resolveProviderConfig({ provider: "ark", apiKey: "k", model: "glm-5.2" });
    // An OpenAI-compatible preset carries no protocol field at all.
    expect(config.protocol).toBeUndefined();
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

  describe("inlineImages", () => {
    it("turns a preset's answer on for a multimodal model on a mixed catalog", () => {
      const config = resolveProviderConfig({
        provider: "ark",
        apiKey: "k",
        model: "doubao-seed-2.0-pro",
        inlineImages: true,
      });
      expect(config.capabilities?.images).toBe(true);
      // Only that one answer changes; the rest of the preset is untouched.
      expect(config.capabilities?.thinking).toBe(false);
      expect(config.capabilities?.costAccounting).toBe(false);
    });

    it("turns a preset's answer off for a text-only model on a seeing endpoint", () => {
      const config = resolveProviderConfig({ provider: "openai", apiKey: "k", inlineImages: false });
      expect(config.capabilities?.images).toBe(false);
    });

    it("materializes the DeepSeek defaults when there is no preset to override", () => {
      // Without the setting this path leaves capabilities undefined on purpose,
      // so the provider keeps its own defaults; asking for images has to
      // produce those same defaults plus the one answer.
      const config = resolveProviderConfig({ apiKey: "k", baseUrl: "https://custom/v1", inlineImages: true });
      expect(config.capabilities).toEqual({ ...DEEPSEEK_CAPABILITIES, images: true });
    });

    it("leaves capabilities exactly as the preset had them when unset", () => {
      const config = resolveProviderConfig({ provider: "ark", apiKey: "k" });
      expect(config.capabilities?.images).toBeUndefined();
      expect(resolveProviderConfig({ apiKey: "k" }).capabilities).toBeUndefined();
    });
  });

  it("passes optional fields through only when defined", () => {
    const config = resolveProviderConfig({
      apiKey: "k",
      model: "deepseek-v4-flash",
      thinking: false,
      reasoningEffort: "max",
      streamIdleTimeoutMs: 5000,
      streamTimeoutMs: 50_000,
      fallbackModel: "deepseek-v4-pro",
    });
    expect(config.thinking).toBe(false);
    expect(config.reasoningEffort).toBe("max");
    expect(config.streamIdleTimeoutMs).toBe(5000);
    expect(config.streamTimeoutMs).toBe(50_000);
    expect(config.fallbackModel).toBe("deepseek-v4-pro");
    expect(config.capabilities).toBeUndefined();
  });
});
