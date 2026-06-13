/**
 * DeepSeek provider module.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDeepSeekProvider(config: ProviderConfig): ChatProvider
 *   parseFallbackToolCalls(text: string): ProviderToolCall[]
 *   estimateCostUsd(usage, model): number
 */

import type { ChatResponse } from "@seekforge/shared";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./constants.js";
import { buildRequestBody, mapChatResponse, mapUsage, type WireChatCompletion } from "./mapping.js";
import { createSseAccumulator, feedSseChunk, finalizeSse } from "./sse.js";
import { DeepSeekApiError, fetchWithRetry, isRetryableError } from "./http.js";
import type { ChatProvider, ChatRequest, ProviderConfig, RetryInfo } from "./types.js";

export type { ProviderConfig, ChatRequest, ChatProvider, RetryInfo } from "./types.js";
export { estimateCostUsd, type UsageTokens } from "./cost.js";
export { MODEL_PRICING, DEFAULT_BASE_URL, DEFAULT_MODEL, DEPRECATED_MODELS, type ModelPricing } from "./constants.js";
export { parseFallbackToolCalls, buildFallbackToolPrompt } from "./fallback.js";
export { DeepSeekApiError } from "./http.js";
export { fetchBalance, type AccountBalance } from "./balance.js";
export { wrapProviderWithCache, type ProviderCacheOptions } from "./cache.js";
export {
  createSseAccumulator,
  feedSseChunk,
  finalizeSse,
  type SseAccumulator,
  type SseResult,
} from "./sse.js";

export function createDeepSeekProvider(config: ProviderConfig): ChatProvider {
  const model = config.model ?? DEFAULT_MODEL;
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`,
  };
  const thinking = {
    ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  };
  const retryOpts = config.onRetry ? { onRetry: config.onRetry } : {};
  // Fallback only engages when configured AND it names a different model than
  // the active primary; otherwise the request path is byte-for-byte unchanged.
  const fallbackModel =
    config.fallbackModel && config.fallbackModel !== model ? config.fallbackModel : undefined;

  /**
   * Run the request against the primary model with the normal retry loop. If
   * `fallbackModel` is configured and the retries exhaust on a *retryable*
   * error, make exactly ONE more attempt with the body rebuilt for the
   * fallback model, announcing it via onRetry. The fallback attempt does not
   * retry; if it fails (for any reason) the ORIGINAL error is rethrown.
   */
  async function fetchWithFallback(req: ChatRequest, stream: boolean): Promise<Response> {
    const primaryBody = JSON.stringify(buildRequestBody(model, req, stream, thinking));
    try {
      return await fetchWithRetry(url, { method: "POST", headers, body: primaryBody }, retryOpts);
    } catch (err) {
      if (fallbackModel === undefined || !isRetryableError(err)) throw err;
      try {
        config.onRetry?.({
          attempt: 0,
          maxAttempts: 0,
          delayMs: 0,
          reason: "falling back to alternate model",
          fallbackModel,
        } satisfies RetryInfo);
      } catch {
        // A misbehaving frontend callback must never break the request path.
      }
      const fallbackBody = JSON.stringify(buildRequestBody(fallbackModel, req, stream, thinking));
      try {
        // maxRetries: 0 → exactly one fallback attempt, no retry storm.
        return await fetchWithRetry(
          url,
          { method: "POST", headers, body: fallbackBody },
          { maxRetries: 0 },
        );
      } catch {
        throw err; // Surface the original (pre-fallback) failure.
      }
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetchWithFallback(req, false);
    const json = (await res.json()) as WireChatCompletion;
    return mapChatResponse(json, model);
  }

  async function chatStream(
    req: ChatRequest,
    onDelta: (chunk: string) => void,
    onReasoningDelta?: (chunk: string) => void,
  ): Promise<ChatResponse> {
    const res = await fetchWithFallback(req, true);
    if (!res.body) {
      throw new DeepSeekApiError("DeepSeek API returned an empty streaming body");
    }
    const acc = createSseAccumulator();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feedSseChunk(acc, decoder.decode(value, { stream: true }), onDelta, onReasoningDelta);
      }
      feedSseChunk(acc, decoder.decode(), onDelta, onReasoningDelta);
    } finally {
      reader.releaseLock();
    }
    const result = finalizeSse(acc);
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: mapUsage(result.usage, model),
      ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
    };
  }

  return { model, chat, chatStream };
}
