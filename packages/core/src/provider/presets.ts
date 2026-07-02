/**
 * Named provider presets: base URL + capability set for the endpoints SeekForge
 * knows how to talk to. `deepseek` is the DeepSeek-direct default (full
 * capabilities); `ark` is Volcengine Ark, an OpenAI-compatible endpoint where
 * the DeepSeek-only behaviors (thinking body, context-cache tokens, pricing,
 * /user/balance) are disabled.
 */

import { DEFAULT_BASE_URL } from "./constants.js";
import {
  DEEPSEEK_CAPABILITIES,
  type ProviderCapabilities,
  type ProviderConfig,
  type RetryInfo,
} from "./types.js";

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

/**
 * Fold a named provider preset into an explicit provider config, producing the
 * `ProviderConfig` for createDeepSeekProvider.
 *
 * - An explicit `baseUrl` always wins over the preset's; the preset only fills
 *   the base URL when the caller left it unset.
 * - `capabilities` come solely from the preset. When no preset matches (the
 *   default DeepSeek path, or an unknown name), capabilities stay undefined so
 *   createDeepSeekProvider keeps its full DeepSeek defaults — byte-for-byte
 *   unchanged for existing callers.
 * Every other field is spread through only when defined, matching the
 * conditional-spread style at the construction sites.
 */
export function resolveProviderConfig(input: {
  provider?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
  streamIdleTimeoutMs?: number;
  onRetry?: (info: RetryInfo) => void;
  fallbackModel?: string;
}): ProviderConfig {
  const preset = resolveProviderPreset(input.provider);
  const baseUrl = input.baseUrl ?? preset?.baseUrl;
  const capabilities = preset?.capabilities;
  return {
    apiKey: input.apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.streamIdleTimeoutMs !== undefined
      ? { streamIdleTimeoutMs: input.streamIdleTimeoutMs }
      : {}),
    ...(input.onRetry !== undefined ? { onRetry: input.onRetry } : {}),
    ...(input.fallbackModel !== undefined ? { fallbackModel: input.fallbackModel } : {}),
  };
}
