import type { TokenUsage } from "@seekforge/shared";
import { FALLBACK_PRICING_MODEL, MODEL_PRICING } from "./constants.js";

export type UsageTokens = Pick<TokenUsage, "promptTokens" | "completionTokens" | "cacheHitTokens">;

/**
 * Estimate the USD cost of a single request from its token usage.
 * Unknown models fall back to deepseek-chat pricing.
 */
export function estimateCostUsd(usage: UsageTokens, model: string): number {
  const pricing = MODEL_PRICING[model] ?? MODEL_PRICING[FALLBACK_PRICING_MODEL];
  if (!pricing) return 0;
  const cacheHit = Math.min(usage.cacheHitTokens, usage.promptTokens);
  const cacheMiss = usage.promptTokens - cacheHit;
  return (
    (cacheMiss * pricing.inputCacheMissPer1M +
      cacheHit * pricing.inputCacheHitPer1M +
      usage.completionTokens * pricing.outputPer1M) /
    1_000_000
  );
}
