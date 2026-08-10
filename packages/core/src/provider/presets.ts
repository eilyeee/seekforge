/**
 * Named provider presets: base URL + capability set for the endpoints SeekForge
 * knows how to talk to. `deepseek` is the DeepSeek-direct default (full
 * capabilities); `ark` is Volcengine Ark, an OpenAI-compatible endpoint where
 * the DeepSeek-only behaviors (thinking body, context-cache tokens, pricing,
 * /user/balance) are disabled.
 */

import { ANTHROPIC_MODELS, DEFAULT_BASE_URL, type ModelPricing, OPENAI_MODELS } from "./constants.js";
import type { WireProtocolId } from "./protocols/types.js";
import { DEEPSEEK_CAPABILITIES, type ProviderCapabilities, type ProviderConfig, type RetryInfo } from "./types.js";

export type ProviderPreset = {
  baseUrl: string;
  capabilities: ProviderCapabilities;
  /** Model ids offered by this provider, for the /model picker and GET /api/models. */
  models: readonly string[];
  /** Wire protocol; unset means the OpenAI-compatible chat-completions line. */
  protocol?: WireProtocolId;
};

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  deepseek: {
    baseUrl: DEFAULT_BASE_URL,
    capabilities: DEEPSEEK_CAPABILITIES,
    // The current non-deprecated V4 models; keep in sync with MODEL_PRICING's V4 entries.
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  ark: {
    baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
    capabilities: { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
    models: [
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
    ],
  },
  // Anthropic speaks its own protocol, not an OpenAI-compatible one — see
  // ./protocols/anthropic.ts. It reports cache reads and ships a published
  // price list, so unlike the OpenAI-compatible non-DeepSeek presets both
  // context-cache accounting and cost accounting stay on. /user/balance is
  // DeepSeek's own endpoint and has no counterpart here.
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic",
    capabilities: { thinking: true, cacheHitTokens: true, costAccounting: true, balance: false, images: true },
    models: ANTHROPIC_MODELS,
  },
  // The presets below are generic OpenAI-compatible endpoints. The DeepSeek-only
  // thinking body and /user/balance are off for all of them.
  //
  // Cost is answered per endpoint by whoever can answer it honestly: OpenAI
  // publishes a price list, so that preset uses it; OpenRouter states the charge
  // in every response, so that preset reads it; `ark` and `ollama` do neither,
  // so they report 0 until the user supplies `modelPricing` — and every surface
  // that shows a cost or arms a cost budget says so rather than showing $0.0000.
  //
  // `images` is a per-ENDPOINT answer to a per-MODEL question, so it is only on
  // where every model in the catalog above accepts an image part: OpenAI's, and
  // OpenRouter's (a router, where the model id picks and the refusal is
  // explicit). It is off for `ark` (doubao-seed is multimodal, kimi and minimax
  // are not — one attached screenshot would 400 the run), off for `ollama`
  // (llama3.1/qwen2.5-coder/deepseek-r1 are text-only; a pulled llava is not),
  // and off for DeepSeek, which has no vision model at all. Any of those is one
  // `inlineImages` setting away from the other answer.
  openai: {
    baseUrl: "https://api.openai.com/v1",
    // cacheHitTokens is on: OpenAI reports its cached input under
    // prompt_tokens_details.cached_tokens, which mapUsage already reads, and
    // the price table below bills those tokens at a tenth. costAccounting is on
    // because that table is OpenAI's own published one — a model missing from
    // it still reports "unknown" rather than borrowing a neighbor's rate.
    capabilities: { thinking: false, cacheHitTokens: true, costAccounting: true, balance: false, images: true },
    // Short representative catalog; users can point at any OpenAI model id.
    models: [...OPENAI_MODELS],
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    capabilities: { thinking: false, cacheHitTokens: false, costAccounting: false, balance: false },
    // Common local models; users can type any model they have pulled.
    models: ["llama3.1", "qwen2.5-coder", "deepseek-r1"],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    // No price table and no need for one: OpenRouter states the charge for
    // every request in usage.cost, and it reports cached reads and writes
    // alongside it. costAccounting stays false — there is no built-in table for
    // 400 models from a dozen vendors — but cost is real here, not 0.
    capabilities: {
      thinking: false,
      cacheHitTokens: true,
      costAccounting: false,
      balance: false,
      images: true,
      usageCost: true,
    },
    // Short representative catalog; OpenRouter exposes many more model ids.
    models: ["anthropic/claude-opus-5", "openai/gpt-5.6-sol", "deepseek/deepseek-v4-pro"],
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
/**
 * Apply the user's `inlineImages` answer over the preset's.
 *
 * Whether a model has eyes is not something a base URL can be asked, so the
 * preset only holds the default for the catalog it ships. A user pointing at
 * doubao-seed, a pulled llava, or a text-only model on an endpoint whose other
 * models are multimodal knows better than the preset does.
 *
 * When the setting is absent this returns the preset's capabilities unchanged —
 * including `undefined` for the no-preset DeepSeek path, which is what keeps
 * createDeepSeekProvider on its own defaults.
 */
function withInlineImages(
  capabilities: ProviderCapabilities | undefined,
  inlineImages: boolean | undefined,
): ProviderCapabilities | undefined {
  if (inlineImages === undefined) return capabilities;
  return { ...(capabilities ?? DEEPSEEK_CAPABILITIES), images: inlineImages };
}

export function resolveProviderConfig(input: {
  provider?: string;
  apiKey: string;
  baseUrl?: string;
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
  streamIdleTimeoutMs?: number;
  streamTimeoutMs?: number;
  onRetry?: (info: RetryInfo) => void;
  fallbackModel?: string;
  modelPricing?: Record<string, ModelPricing>;
  inlineImages?: boolean;
}): ProviderConfig {
  const preset = resolveProviderPreset(input.provider);
  const baseUrl = input.baseUrl ?? preset?.baseUrl;
  const capabilities = withInlineImages(preset?.capabilities, input.inlineImages);
  return {
    apiKey: input.apiKey,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    // The protocol travels with the preset, never with the URL: pointing a
    // preset at a proxy keeps the wire format it was chosen for.
    ...(preset?.protocol !== undefined ? { protocol: preset.protocol } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(input.modelPricing !== undefined ? { modelPricing: input.modelPricing } : {}),
    ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs: input.streamIdleTimeoutMs } : {}),
    ...(input.streamTimeoutMs !== undefined ? { streamTimeoutMs: input.streamTimeoutMs } : {}),
    ...(input.onRetry !== undefined ? { onRetry: input.onRetry } : {}),
    ...(input.fallbackModel !== undefined ? { fallbackModel: input.fallbackModel } : {}),
  };
}
