/**
 * DeepSeek provider module.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDeepSeekProvider(config: ProviderConfig): ChatProvider
 *   parseFallbackToolCalls(text: string): ProviderToolCall[]
 *   estimateCostUsd(usage, model): number
 */

import type { ChatResponse } from "@seekforge/shared";
import * as crypto from "node:crypto";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./constants.js";
import { buildRequestBody, mapChatResponse, mapUsage, type WireChatCompletion } from "./mapping.js";
import { createSseAccumulator, feedSseChunk, finalizeSse } from "./sse.js";
import { DeepSeekApiError, fetchWithRetry, isRetryableError } from "./http.js";
import { DEEPSEEK_CAPABILITIES } from "./types.js";
import type { ChatProvider, ChatRequest, ProviderConfig, RetryInfo } from "./types.js";

export type { ProviderConfig, ChatRequest, ChatProvider, RetryInfo, ProviderCapabilities } from "./types.js";
export { DEEPSEEK_CAPABILITIES } from "./types.js";
export {
  PROVIDER_PRESETS,
  resolveProviderPreset,
  resolveProviderConfig,
  type ProviderPreset,
} from "./presets.js";
export { estimateCostUsd, type UsageTokens } from "./cost.js";
export { MODEL_PRICING, DEFAULT_BASE_URL, DEFAULT_MODEL, DEPRECATED_MODELS, type ModelPricing } from "./constants.js";
export { parseFallbackToolCalls, buildFallbackToolPrompt } from "./fallback.js";
export { DeepSeekApiError } from "./http.js";
export { fetchBalance, type AccountBalance } from "./balance.js";
export { wrapProviderWithCache, type ProviderCacheOptions } from "./cache.js";
export { ProviderProtocolError } from "./mapping.js";
export {
  createSseAccumulator,
  feedSseChunk,
  finalizeSse,
  MAX_SSE_LINE_CHARS,
  type SseAccumulator,
  type SseResult,
} from "./sse.js";

/** No bytes for this long mid-stream = the response stalled (complements the TTFB timeout). */
const STREAM_IDLE_TIMEOUT_MS = 120_000;

/** Read one chunk, rejecting if the stream sends nothing for `idleMs` (a stall). */
async function readWithIdleTimeout<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new DeepSeekApiError(`streaming response stalled (no data for ${idleMs}ms)`)),
      idleMs,
    );
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

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
  // Unset capabilities → full DeepSeek-direct behavior, so the request/response
  // path is byte-for-byte unchanged for existing (DeepSeek) callers.
  const capabilities = config.capabilities ?? DEEPSEEK_CAPABILITIES;
  const retryOpts = config.onRetry ? { onRetry: config.onRetry } : {};
  // Fallback only engages when configured AND it names a different model than
  // the active primary; otherwise the request path is byte-for-byte unchanged.
  const fallbackModel =
    config.fallbackModel && config.fallbackModel !== model ? config.fallbackModel : undefined;
  const cacheIdentity = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      baseUrl,
      apiKey: config.apiKey,
      model,
      capabilities,
      thinking: config.thinking ?? null,
      reasoningEffort: config.reasoningEffort ?? null,
      fallbackModel: fallbackModel ?? null,
      modelPricing: config.modelPricing ?? null,
    }))
    .digest("hex");

  /**
   * Run the request against the primary model with the normal retry loop. If
   * `fallbackModel` is configured and the retries exhaust on a *retryable*
   * error, make exactly ONE more attempt with the body rebuilt for the
   * fallback model, announcing it via onRetry. The fallback attempt does not
   * retry; if it fails (for any reason) the ORIGINAL error is rethrown.
   */
  async function fetchWithFallback<T>(
    req: ChatRequest,
    stream: boolean,
    handleResponse: (response: Response) => Promise<T>,
  ): Promise<{ result: T; effectiveModel: string }> {
    const primaryBody = JSON.stringify(buildRequestBody(model, req, stream, thinking, capabilities));
    try {
      const result = await fetchWithRetry(
        url,
        { method: "POST", headers, body: primaryBody, signal: req.signal },
        { ...retryOpts, timeoutBody: !stream },
        handleResponse,
      );
      return { result, effectiveModel: model };
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
      const fallbackBody = JSON.stringify(
        buildRequestBody(fallbackModel, req, stream, thinking, capabilities),
      );
      try {
        // maxRetries: 0 → exactly one fallback attempt, no retry storm.
        const result = await fetchWithRetry(
          url,
          { method: "POST", headers, body: fallbackBody, signal: req.signal },
          { maxRetries: 0, timeoutBody: !stream },
          handleResponse,
        );
        return { result, effectiveModel: fallbackModel };
      } catch {
        if (req.signal?.aborted) throw req.signal.reason;
        throw err; // Surface the original (pre-fallback) failure.
      }
    }
  }

  async function chat(req: ChatRequest): Promise<ChatResponse> {
    const { result: json, effectiveModel } = await fetchWithFallback(
      req,
      false,
      async (response) => (await response.json()) as WireChatCompletion,
    );
    return mapChatResponse(json, effectiveModel, capabilities, config.modelPricing);
  }

  async function chatStream(
    req: ChatRequest,
    onDelta: (chunk: string) => void,
    onReasoningDelta?: (chunk: string) => void,
  ): Promise<ChatResponse> {
    const { result: res, effectiveModel } = await fetchWithFallback(
      req,
      true,
      async (response) => response,
    );
    if (!res.body) {
      throw new DeepSeekApiError("DeepSeek API returned an empty streaming body");
    }
    const acc = createSseAccumulator();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        // Idle timeout: if the stream sends no bytes for STREAM_IDLE_TIMEOUT_MS
        // it has stalled mid-response (the TTFB timeout only covers headers).
        // Bail with a clear error instead of hanging forever.
        const { done, value } = await readWithIdleTimeout(
          reader,
          config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
          req.signal,
        );
        if (done) break;
        feedSseChunk(acc, decoder.decode(value, { stream: true }), onDelta, onReasoningDelta);
      }
      feedSseChunk(acc, decoder.decode(), onDelta, onReasoningDelta);
      reader.releaseLock();
    } catch (err) {
      // A stall (or any read error) leaves a pending read — cancel to settle it
      // and tear down the connection, then propagate.
      await reader.cancel().catch(() => {});
      throw err;
    }
    const result = finalizeSse(acc);
    if (!acc.done) {
      throw new DeepSeekApiError("streaming response ended before [DONE]");
    }
    return {
      content: result.content,
      toolCalls: result.toolCalls,
      finishReason: result.finishReason,
      usage: mapUsage(result.usage, effectiveModel, capabilities, config.modelPricing),
      ...(result.reasoningContent ? { reasoningContent: result.reasoningContent } : {}),
    };
  }

  return { model, cacheIdentity, chat, chatStream };
}
