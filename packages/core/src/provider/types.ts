import type { ChatMessage, ChatResponse, ToolDefinitionForModel } from "@seekforge/shared";
import type { ModelPricing } from "./constants.js";

/**
 * Reported just before each retry backoff sleep in fetchWithRetry. `attempt`
 * is 1-based (the upcoming retry number); `maxAttempts` is the total retry
 * budget. `reason` is a short human-readable cause ("rate limited", "server
 * error (503)", "network error"). Lets a frontend surface retry progress.
 */
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  /**
   * Set only on the final fallback notice (see ProviderConfig.fallbackModel):
   * the model id the request is being retried with after the primary model
   * exhausted its retry budget. Absent on ordinary same-model retries.
   */
  fallbackModel?: string;
};

/**
 * Per-provider feature switches. DeepSeek-direct enables all four; an
 * OpenAI-compatible endpoint (e.g. Volcengine Ark) disables the DeepSeek-only
 * behaviors so its models are not sent parameters they reject or priced against
 * the DeepSeek table. When a ProviderConfig leaves `capabilities` unset the
 * provider defaults to DEEPSEEK_CAPABILITIES, so existing behavior is
 * byte-for-byte unchanged.
 */
export type ProviderCapabilities = {
  /** Send the DeepSeek-style thinking.{type,reasoning_effort} request body. */
  thinking: boolean;
  /** Read prompt_cache_hit_tokens from usage (DeepSeek context cache). */
  cacheHitTokens: boolean;
  /** Apply the built-in pricing table; false → costUsd reported as 0. */
  costAccounting: boolean;
  /** Provider exposes a /user/balance endpoint (DeepSeek only). */
  balance: boolean;
};

/** Full DeepSeek-direct capability set (the default when `capabilities` is unset). */
export const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  thinking: true,
  cacheHitTokens: true,
  costAccounting: true,
  balance: true,
};

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  /** "deepseek-v4-flash" | "deepseek-v4-pro" (legacy: deepseek-chat/reasoner). */
  model?: string;
  /** Mid-stream idle timeout (ms): no bytes for this long aborts a stalled stream. Default 120000. */
  streamIdleTimeoutMs?: number;
  /** Total streaming body timeout (ms), independent of progress. Default 600000. */
  streamTimeoutMs?: number;
  /**
   * Called before each retry backoff in fetchWithRetry, so a frontend can
   * surface retry progress ("⟳ retrying (2/3)…"). Never throws into the
   * request path — the provider ignores callback errors.
   */
  onRetry?: (info: RetryInfo) => void;
  /**
   * DeepSeek V4 thinking mode. true/false sends thinking.type
   * enabled/disabled; unset sends nothing (API default). Only attached for
   * deepseek-v4-* models — legacy models reject the parameter.
   */
  thinking?: boolean;
  /** V4 reasoning effort ("low"/"medium" map to "high" server-side). */
  reasoningEffort?: "high" | "max";
  /**
   * If set, after the primary `model` exhausts its retry budget on a *retryable*
   * error (HTTP 429 / 5xx / network), the request makes ONE final attempt with
   * `model` swapped to this fallback id. The swap is skipped when the fallback
   * equals the active model. When the fallback attempt is made, `onRetry` fires
   * once more with `fallbackModel` set; if it too fails, the ORIGINAL
   * (pre-fallback) error is thrown. Leaving this unset keeps behavior identical.
   */
  fallbackModel?: string;
  /**
   * Provider feature switches. When unset the provider defaults to
   * DEEPSEEK_CAPABILITIES (full DeepSeek-direct behavior), keeping backward
   * compatibility byte-for-byte.
   */
  capabilities?: ProviderCapabilities;
  /**
   * User-supplied per-model price table (model id → per-1M rates) for providers
   * that ship no built-in pricing (Ark, OpenAI, …). When an entry exists for the
   * active model its cost is ALWAYS computed from these rates — even when
   * `capabilities.costAccounting` is false — so budgets work on those providers.
   * Unset (the DeepSeek default) leaves cost accounting byte-for-byte unchanged.
   */
  modelPricing?: Record<string, ModelPricing>;
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinitionForModel[];
  temperature?: number;
  maxTokens?: number;
  /** Cancels the active request, response-body read, retry wait, or stream read. */
  signal?: AbortSignal;
};

export interface ChatProvider {
  chat(req: ChatRequest): Promise<ChatResponse>;
  chatStream(
    req: ChatRequest,
    onDelta: (chunk: string) => void,
    /** Streamed chain-of-thought deltas (V4 thinking mode), kept separate from content. */
    onReasoningDelta?: (chunk: string) => void,
  ): Promise<ChatResponse>;
  readonly model: string;
  /** Opaque identity for response-affecting endpoint/provider/tenant config. */
  readonly cacheIdentity?: string;
}
