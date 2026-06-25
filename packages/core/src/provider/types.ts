import type { ChatMessage, ChatResponse, ToolDefinitionForModel } from "@seekforge/shared";

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

export type ProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  /** "deepseek-v4-flash" | "deepseek-v4-pro" (legacy: deepseek-chat/reasoner). */
  model?: string;
  /** Mid-stream idle timeout (ms): no bytes for this long aborts a stalled stream. Default 120000. */
  streamIdleTimeoutMs?: number;
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
};

export type ChatRequest = {
  messages: ChatMessage[];
  tools?: ToolDefinitionForModel[];
  temperature?: number;
  maxTokens?: number;
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
}
