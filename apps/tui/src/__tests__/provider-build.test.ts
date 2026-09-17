import { describe, expect, it } from "vitest";
import { buildProvider, createDeepSeekProvider } from "@seekforge/core";
import { buildTuiProvider, tuiProviderInput } from "../agent/factory.js";

describe("buildTuiProvider", () => {
  it("honors the configured provider preset instead of assuming DeepSeek", () => {
    const config = { provider: "anthropic", apiKey: "k" };
    const built = buildTuiProvider(config, "claude-x");
    // cacheIdentity hashes endpoint + protocol + capabilities, so equal
    // identities mean the same wire destination and format.
    expect(built.cacheIdentity).toBe(buildProvider({ provider: "anthropic", apiKey: "k" }, "claude-x").cacheIdentity);
    expect(built.cacheIdentity).not.toBe(createDeepSeekProvider({ apiKey: "k", model: "claude-x" }).cacheIdentity);
  });

  it("defaults to the configured model", () => {
    expect(buildTuiProvider({ apiKey: "k", model: "deepseek-v4-pro" }).model).toBe("deepseek-v4-pro");
    expect(buildTuiProvider({ apiKey: "k", model: "deepseek-v4-pro" }, "other").model).toBe("other");
  });

  it("maps every provider-shaping key the run factory uses", () => {
    expect(
      tuiProviderInput({
        provider: "ark",
        apiKey: "k",
        baseUrl: "https://example.test",
        thinking: false,
        reasoningEffort: "max",
        inlineImages: true,
        modelPricing: { m: { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0.1, outputPer1M: 2 } },
      }),
    ).toEqual({
      provider: "ark",
      apiKey: "k",
      baseUrl: "https://example.test",
      thinking: false,
      reasoningEffort: "max",
      inlineImages: true,
      modelPricing: { m: { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0.1, outputPer1M: 2 } },
    });
  });
});
