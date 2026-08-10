export const DEFAULT_BASE_URL = "https://api.deepseek.com";
// deepseek-chat/reasoner are deprecated upstream (2026-07-24) and no longer
// listed on /models for new keys — V4 flash is the working default.
export const DEFAULT_MODEL = "deepseek-v4-flash";

/**
 * Models that are deprecated upstream (no longer returned by /models for new
 * API keys). Keep pricing and display support for users with existing keys,
 * but flag them when listing.
 */
export const DEPRECATED_MODELS = ["deepseek-chat", "deepseek-reasoner"] as const;

/** USD per 1M tokens, split by cache hit/miss on the input side. */
export type ModelPricing = {
  inputCacheMissPer1M: number;
  inputCacheHitPer1M: number;
  /**
   * Rate for prompt tokens WRITTEN to the cache, where a provider charges a
   * premium for populating it. Omitted means "same as a cache miss", which is
   * how every provider without an explicit write price behaves.
   */
  inputCacheWritePer1M?: number;
  outputPer1M: number;
};

/**
 * Claude models offered by the `anthropic` preset, newest first. Any other
 * model id still works — this is the picker's catalog, not a whitelist.
 */
export const ANTHROPIC_MODELS = [
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-opus-4-8",
  "claude-fable-5",
] as const;

/**
 * Anthropic pricing, USD per 1M tokens.
 * Source of truth: https://platform.claude.com/docs/en/pricing — check there
 * when updating. Verified 2026-08-03.
 *
 * Cache reads bill at a tenth of the input rate and cache writes at 1.25x it,
 * which is what `inputCacheHitPer1M` and `inputCacheWritePer1M` carry.
 *
 * `claude-sonnet-5` is listed at its standard rate. An introductory rate runs
 * through 2026-08-31; until then this over-reports that model's cost, which is
 * the safer direction for a budget than under-reporting it.
 */
export const ANTHROPIC_MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputCacheMissPer1M: 10, inputCacheHitPer1M: 1, inputCacheWritePer1M: 12.5, outputPer1M: 50 },
  "claude-mythos-5": { inputCacheMissPer1M: 10, inputCacheHitPer1M: 1, inputCacheWritePer1M: 12.5, outputPer1M: 50 },
  "claude-opus-5": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, inputCacheWritePer1M: 6.25, outputPer1M: 25 },
  "claude-opus-4-8": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, inputCacheWritePer1M: 6.25, outputPer1M: 25 },
  "claude-opus-4-7": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, inputCacheWritePer1M: 6.25, outputPer1M: 25 },
  "claude-opus-4-6": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, inputCacheWritePer1M: 6.25, outputPer1M: 25 },
  "claude-sonnet-5": { inputCacheMissPer1M: 3, inputCacheHitPer1M: 0.3, inputCacheWritePer1M: 3.75, outputPer1M: 15 },
  "claude-sonnet-4-6": { inputCacheMissPer1M: 3, inputCacheHitPer1M: 0.3, inputCacheWritePer1M: 3.75, outputPer1M: 15 },
  "claude-haiku-4-5": { inputCacheMissPer1M: 1, inputCacheHitPer1M: 0.1, inputCacheWritePer1M: 1.25, outputPer1M: 5 },
};

/**
 * OpenAI models offered by the `openai` preset, newest first. Any other model
 * id still works — this is the picker's catalog, not a whitelist.
 */
export const OPENAI_MODELS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
] as const;

/**
 * OpenAI pricing, USD per 1M tokens.
 * Source of truth: https://developers.openai.com/api/docs/pricing — check there
 * when updating. Verified 2026-08-07, standard tier.
 *
 * The `-pro` models publish no cached-input rate because they do not serve one;
 * their hit rate is written as the ordinary input rate, which is what an
 * uncached token costs, so a stray cache-hit count cannot under-report them.
 *
 * These are OpenAI's own rates and apply to the `openai` preset. The same model
 * reached through OpenRouter bills at OpenRouter's price, which is why that
 * preset reads the cost off the response instead of this table.
 */
export const OPENAI_MODEL_PRICING: Record<string, ModelPricing> = {
  "gpt-5.6-sol": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, outputPer1M: 30 },
  "gpt-5.6-terra": { inputCacheMissPer1M: 2, inputCacheHitPer1M: 0.2, outputPer1M: 12 },
  "gpt-5.6-luna": { inputCacheMissPer1M: 0.2, inputCacheHitPer1M: 0.02, outputPer1M: 1.2 },
  "gpt-5.5": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 0.5, outputPer1M: 30 },
  "gpt-5.5-pro": { inputCacheMissPer1M: 30, inputCacheHitPer1M: 30, outputPer1M: 180 },
  "gpt-5.4": { inputCacheMissPer1M: 2.5, inputCacheHitPer1M: 0.25, outputPer1M: 15 },
  "gpt-5.4-mini": { inputCacheMissPer1M: 0.75, inputCacheHitPer1M: 0.075, outputPer1M: 4.5 },
  "gpt-5.4-nano": { inputCacheMissPer1M: 0.2, inputCacheHitPer1M: 0.02, outputPer1M: 1.25 },
  "gpt-5.4-pro": { inputCacheMissPer1M: 30, inputCacheHitPer1M: 30, outputPer1M: 180 },
  "gpt-5.2": { inputCacheMissPer1M: 1.75, inputCacheHitPer1M: 0.175, outputPer1M: 14 },
  "gpt-5.2-pro": { inputCacheMissPer1M: 21, inputCacheHitPer1M: 21, outputPer1M: 168 },
  "gpt-5.1": { inputCacheMissPer1M: 1.25, inputCacheHitPer1M: 0.125, outputPer1M: 10 },
  "gpt-5": { inputCacheMissPer1M: 1.25, inputCacheHitPer1M: 0.125, outputPer1M: 10 },
  "gpt-5-mini": { inputCacheMissPer1M: 0.25, inputCacheHitPer1M: 0.025, outputPer1M: 2 },
  "gpt-5-nano": { inputCacheMissPer1M: 0.05, inputCacheHitPer1M: 0.005, outputPer1M: 0.4 },
  "gpt-5-pro": { inputCacheMissPer1M: 15, inputCacheHitPer1M: 15, outputPer1M: 120 },
};

/**
 * Built-in pricing: every model SeekForge ships a published price for.
 *
 * DeepSeek rates come from https://api-docs.deepseek.com/quick_start/pricing —
 * check there when updating. A model that is not listed here has no built-in
 * price and must be given one via `modelPricing` (see docs/configuration.md);
 * an invented rate would silently mis-bill every budget derived from it.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
  ...ANTHROPIC_MODEL_PRICING,
  ...OPENAI_MODEL_PRICING,
  "deepseek-chat": {
    inputCacheMissPer1M: 0.28,
    inputCacheHitPer1M: 0.028,
    outputPer1M: 0.42,
  },
  "deepseek-reasoner": {
    inputCacheMissPer1M: 0.28,
    inputCacheHitPer1M: 0.028,
    outputPer1M: 0.42,
  },
  // V4 models (thinking mode + tool calling). Verified against the pricing
  // page 2026-06-12.
  "deepseek-v4-flash": {
    inputCacheMissPer1M: 0.14,
    inputCacheHitPer1M: 0.0028,
    outputPer1M: 0.28,
  },
  "deepseek-v4-pro": {
    inputCacheMissPer1M: 0.435,
    inputCacheHitPer1M: 0.003625,
    outputPer1M: 0.87,
  },
};

/** Pricing used when the model id is not in the table. */
export const FALLBACK_PRICING_MODEL = DEFAULT_MODEL;

/**
 * The fallback price is one vendor's rate, so it may only stand in for that
 * vendor's other models. A Claude model priced at DeepSeek's rates would report
 * a cost off by more than an order of magnitude, which is worse than reporting
 * that the price is unknown — see `pricingSourceFor`.
 */
export const FALLBACK_PRICING_FAMILY = "deepseek";
