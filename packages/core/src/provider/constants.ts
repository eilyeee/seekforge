export const DEFAULT_BASE_URL = "https://api.deepseek.com";
// deepseek-chat/reasoner are deprecated upstream (2026-07-24) and no longer
// listed on /models for new keys — V4 flash is the working default.
export const DEFAULT_MODEL = "deepseek-v4-flash";

/** USD per 1M tokens, split by cache hit/miss on the input side. */
export type ModelPricing = {
  inputCacheMissPer1M: number;
  inputCacheHitPer1M: number;
  outputPer1M: number;
};

/**
 * DeepSeek pricing table.
 * Source of truth: https://api-docs.deepseek.com/quick_start/pricing — check there
 * when updating. Phase 0 only needs the structure to be right, not the cents.
 */
export const MODEL_PRICING: Record<string, ModelPricing> = {
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
