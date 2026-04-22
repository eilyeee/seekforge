export const DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL = "deepseek-chat";

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
  // V4 models (thinking mode + tool calling). Same placeholder rates until
  // the pricing page is re-checked — structure over cents, as above.
  "deepseek-v4-flash": {
    inputCacheMissPer1M: 0.28,
    inputCacheHitPer1M: 0.028,
    outputPer1M: 0.42,
  },
  "deepseek-v4-pro": {
    inputCacheMissPer1M: 0.28,
    inputCacheHitPer1M: 0.028,
    outputPer1M: 0.42,
  },
};

/** Pricing used when the model id is not in the table. */
export const FALLBACK_PRICING_MODEL = "deepseek-chat";
