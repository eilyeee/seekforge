import type { TokenUsage } from "@seekforge/shared";
import { FALLBACK_PRICING_FAMILY, FALLBACK_PRICING_MODEL, MODEL_PRICING, type ModelPricing } from "./constants.js";

/**
 * The default model's rates, but only for models it can plausibly speak for.
 * Borrowing DeepSeek's price for another DeepSeek id is an estimate; borrowing
 * it for a Claude id is a wrong number wearing a right one's clothes.
 */
function fallbackPricingFor(model: string): ModelPricing | undefined {
  return model.toLowerCase().startsWith(FALLBACK_PRICING_FAMILY) ? MODEL_PRICING[FALLBACK_PRICING_MODEL] : undefined;
}

export type UsageTokens = Pick<TokenUsage, "promptTokens" | "completionTokens" | "cacheHitTokens"> & {
  /** Prompt tokens written to the cache; billed above the miss rate where a provider says so. */
  cacheWriteTokens?: number;
};

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
export type PricingSource = "configured" | "provider" | "builtin" | "fallback" | "unavailable";

/**
 * Where the price used for `model` comes from.
 *
 * `costAccounting: false` means no built-in table applies, so the price has to
 * come from somewhere else: the endpoint's own reported charge (`usageCost`, on
 * a router whose rates no shipped table could track) or a user-supplied
 * `modelPricing` entry. With neither, it is genuinely unknown — and a caller
 * that reports spend or arms a cost budget has to say so rather than treat the
 * resulting 0 as a real number.
 */
export function pricingSourceFor(
  model: string,
  options: { pricing?: Record<string, ModelPricing>; costAccounting?: boolean; usageCost?: boolean } = {},
): PricingSource {
  if (options.pricing?.[model] !== undefined) return "configured";
  if (options.usageCost === true) return "provider";
  if (options.costAccounting === false) return "unavailable";
  if (MODEL_PRICING[model] !== undefined) return "builtin";
  return fallbackPricingFor(model) !== undefined ? "fallback" : "unavailable";
}

export function estimateCostUsd(usage: UsageTokens, model: string, pricing?: Record<string, ModelPricing>): number {
  const rates = pricing?.[model] ?? MODEL_PRICING[model] ?? fallbackPricingFor(model);
  if (!rates) return 0;
  const cacheHit = Math.min(usage.cacheHitTokens, usage.promptTokens);
  // Hits and writes are both subsets of the prompt, and a token is never both.
  // Whatever is left over was processed at the ordinary input rate.
  const cacheWrite = Math.min(Math.max(usage.cacheWriteTokens ?? 0, 0), usage.promptTokens - cacheHit);
  const cacheMiss = usage.promptTokens - cacheHit - cacheWrite;
  const cost =
    (cacheMiss * rates.inputCacheMissPer1M +
      cacheHit * rates.inputCacheHitPer1M +
      // A provider that charges nothing extra to populate its cache simply has
      // no write rate; those tokens then bill exactly like a miss, which is
      // what they are.
      cacheWrite * (rates.inputCacheWritePer1M ?? rates.inputCacheMissPer1M) +
      usage.completionTokens * rates.outputPer1M) /
    1_000_000;
  return Number.isFinite(cost) && cost >= 0 ? cost : 0;
}
