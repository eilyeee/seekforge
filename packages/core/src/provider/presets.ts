/**
 * Named provider presets: base URL + capability set for the endpoints SeekForge
 * knows how to talk to. `deepseek` is the DeepSeek-direct default (full
 * capabilities); `ark` is Volcengine Ark, an OpenAI-compatible endpoint where
 * the DeepSeek-only behaviors (thinking body, context-cache tokens, pricing,
 * /user/balance) are disabled.
 */

import { DEFAULT_BASE_URL } from "./constants.js";
import { DEEPSEEK_CAPABILITIES, type ProviderCapabilities } from "./types.js";

export type ProviderPreset = { baseUrl: string; capabilities: ProviderCapabilities };

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: { baseUrl: DEFAULT_BASE_URL, capabilities: DEEPSEEK_CAPABILITIES },
  ark: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    capabilities: { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
  },
};

/** Case-insensitive lookup; returns undefined for an unknown preset name. */
export function resolveProviderPreset(name?: string): ProviderPreset | undefined {
  if (name === undefined) return undefined;
  return PROVIDER_PRESETS[name.toLowerCase()];
}
