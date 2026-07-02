import { describe, expect, it } from "vitest";
import {
  PROVIDER_PRESETS,
  resolveProviderPreset,
} from "../../src/provider/presets.js";
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
  });

  it("returns the DeepSeek preset with full capabilities for 'deepseek'", () => {
    const preset = resolveProviderPreset("deepseek");
    expect(preset).toBeDefined();
    expect(preset?.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(preset?.capabilities).toEqual(DEEPSEEK_CAPABILITIES);
    expect(preset?.capabilities.thinking).toBe(true);
  });

  it("returns undefined for an unknown or missing preset name", () => {
    expect(resolveProviderPreset("openai")).toBeUndefined();
    expect(resolveProviderPreset("")).toBeUndefined();
    expect(resolveProviderPreset(undefined)).toBeUndefined();
  });

  it("exposes both presets on PROVIDER_PRESETS", () => {
    expect(Object.keys(PROVIDER_PRESETS).sort()).toEqual(["ark", "deepseek"]);
  });
});
