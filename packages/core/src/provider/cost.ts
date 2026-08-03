import type { TokenUsage } from "@seekforge/shared";
import { FALLBACK_PRICING_MODEL, MODEL_PRICING, type ModelPricing } from "./constants.js";

export type UsageTokens = Pick<TokenUsage, "promptTokens" | "completionTokens" | "cacheHitTokens">;

/**
 * Estimate the USD cost of a single request from its token usage.
 *
 * `pricing` is an optional user-supplied price table (model id → per-1M rates)
 * for providers without a built-in table (Ark, OpenAI, …). When it carries an
 * entry for `model` that entry is used; otherwise the lookup falls back to the
 * built-in MODEL_PRICING (and, failing that, the default model's pricing).
 */
/**
 * Where a model's price comes from, if anywhere.
 *
 * "unavailable" is the one that matters: a cost of 0 is indistinguishable from
 * a free call, so a caller that reports spend has to be able to say "unknown"
 * instead of "$0.0000".
 */
export type PricingSource = "configured" | "builtin" | "fallback" | "unavailable";

/**
 * Where the price used for `model` comes from.
 *
 * `costAccounting: false` (every non-DeepSeek preset) means no built-in table
 * applies at all, so only a user-supplied `modelPricing` entry can price it.
 */
export function pricingSourceFor(
  model: string,
  options: { pricing?: Record<string, ModelPricing>; costAccounting?: boolean } = {},
): PricingSource {
  if (options.pricing?.[model] !== undefined) return "configured";
  if (options.costAccounting === false) return "unavailable";
  if (MODEL_PRICING[model] !== undefined) return "builtin";
  return MODEL_PRICING[FALLBACK_PRICING_MODEL] !== undefined ? "fallback" : "unavailable";
}

export function estimateCostUsd(usage: UsageTokens, model: string, pricing?: Record<string, ModelPricing>): number {
  const rates = pricing?.[model] ?? MODEL_PRICING[model] ?? MODEL_PRICING[FALLBACK_PRICING_MODEL];
  if (!rates) return 0;
  const cacheHit = Math.min(usage.cacheHitTokens, usage.promptTokens);
  const cacheMiss = usage.promptTokens - cacheHit;
  const cost =
    (cacheMiss * rates.inputCacheMissPer1M +
      cacheHit * rates.inputCacheHitPer1M +
      usage.completionTokens * rates.outputPer1M) /
    1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}
