/**
 * DeepSeek provider module.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDeepSeekProvider(config: ProviderConfig): ChatProvider
 *   parseFallbackToolCalls(text: string): ProviderToolCall[]
 *   estimateCostUsd(usage, model): number
 */

import type { ChatResponse } from "@seekforge/shared";
import { onAbortOnce } from "../util/abort.js";
import * as crypto from "node:crypto";
import { DEFAULT_BASE_URL, DEFAULT_MODEL } from "./constants.js";
import {
  buildRequestBody,
  mapChatResponse,
  mapUsage,
  ProviderProtocolError,
  type WireChatCompletion,
} from "./mapping.js";
import { createSseAccumulator, feedSseChunk, finalizeSse } from "./sse.js";
import { DeepSeekApiError, fetchWithRetry, isRetryableError, readJsonResponseBounded } from "./http.js";
import { DEEPSEEK_CAPABILITIES } from "./types.js";
import type { ChatProvider, ChatRequest, ProviderConfig, RetryInfo } from "./types.js";
import { MAX_PROVIDER_RESPONSE_BYTES } from "./protocol-limits.js";

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
export { MAX_PROVIDER_RESPONSE_BYTES } from "./protocol-limits.js";
export { fetchBalance, verifyDeepSeekAccess, type AccountBalance, type ProviderAccessCheck } from "./balance.js";
export { wrapProviderWithCache, type ProviderCacheOptions } from "./cache.js";
export { ProviderProtocolError } from "./mapping.js";
export {
  createSseAccumulator,
  feedSseChunk,
  finalizeSse,
  MAX_SSE_LINE_CHARS,
  MAX_SSE_CONTENT_CHARS,
  MAX_SSE_DECODED_CHARS,
  MAX_SSE_REASONING_CHARS,
  MAX_SSE_TOOL_ARGUMENT_CHARS,
  MAX_SSE_TOOL_CALLS,
  MAX_SSE_TOTAL_TOOL_ARGUMENT_CHARS,
  type SseLimits,
  type SseAccumulator,
  type SseResult,
} from "./sse.js";

/** No bytes for this long mid-stream = the response stalled (complements the TTFB timeout). */
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const STREAM_TOTAL_TIMEOUT_MS = 600_000;
export { MAX_PROVIDER_RESPONSE_BYTES as MAX_SSE_STREAM_BYTES } from "./protocol-limits.js";

function boundedTimeoutMs(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 2_147_483_647)
    : fallback;
}

/** Read one chunk, rejecting if the stream sends nothing for `idleMs` (a stall). */
async function readWithTimeouts<T>(
  reader: ReadableStreamDefaultReader<T>,
  idleMs: number,
  totalRemainingMs: number,
  totalMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason;
  if (totalRemainingMs <= 0) {
    throw new DeepSeekApiError(`streaming response timed out after ${totalMs}ms`);
  }
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const idleTimeout = new Promise<never>((_resolve, reject) => {
    idleTimer = setTimeout(
      () => reject(new DeepSeekApiError(`streaming response stalled (no data for ${idleMs}ms)`)),
      idleMs,
    );
  });
  const totalTimeout = new Promise<never>((_resolve, reject) => {
    totalTimer = setTimeout(
      () => reject(new DeepSeekApiError(`streaming response timed out after ${totalMs}ms`)),
      totalRemainingMs,
    );
  });
  let offAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    // onAbortOnce fires immediately on an already-aborted signal, closing the
    // guard-then-subscribe race the hand-rolled listener left open.
    offAbort = onAbortOnce(signal, () => reject(signal?.reason));
  });
  try {
    return await Promise.race([reader.read(), idleTimeout, totalTimeout, aborted]);
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (totalTimer !== undefined) clearTimeout(totalTimer);
    offAbort();
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
  const fallbackModel = config.fallbackModel && config.fallbackModel !== model ? config.fallbackModel : undefined;
  const cacheIdentity = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        baseUrl,
        apiKey: config.apiKey,
        model,
        capabilities,
        thinking: config.thinking ?? null,
        reasoningEffort: config.reasoningEffort ?? null,
        fallbackModel: fallbackModel ?? null,
        modelPricing: config.modelPricing ?? null,
      }),
    )
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
      const fallbackBody = JSON.stringify(buildRequestBody(fallbackModel, req, stream, thinking, capabilities));
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
      async (response) => (await readJsonResponseBounded(response)) as WireChatCompletion,
    );
    return mapChatResponse(json, effectiveModel, capabilities, config.modelPricing);
  }

  async function chatStream(
    req: ChatRequest,
    onDelta: (chunk: string) => void,
    onReasoningDelta?: (chunk: string) => void,
  ): Promise<ChatResponse> {
    const { result: res, effectiveModel } = await fetchWithFallback(req, true, async (response) => response);
    if (!res.body) {
      throw new DeepSeekApiError("DeepSeek API returned an empty streaming body");
    }
    const acc = createSseAccumulator();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    const idleTimeoutMs = boundedTimeoutMs(config.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_MS);
    const totalTimeoutMs = boundedTimeoutMs(config.streamTimeoutMs, STREAM_TOTAL_TIMEOUT_MS);
    const deadline = Date.now() + totalTimeoutMs;
    let streamBytes = 0;
    try {
      for (;;) {
        // Idle timeout: if the stream sends no bytes for STREAM_IDLE_TIMEOUT_MS
        // it has stalled mid-response (the TTFB timeout only covers headers).
        // Bail with a clear error instead of hanging forever.
        const { done, value } = await readWithTimeouts(
          reader,
          idleTimeoutMs,
          deadline - Date.now(),
          totalTimeoutMs,
          req.signal,
        );
        if (done) break;
        if (value.byteLength > MAX_PROVIDER_RESPONSE_BYTES - streamBytes) {
          throw new ProviderProtocolError(
            `Provider protocol error: SSE stream exceeds ${MAX_PROVIDER_RESPONSE_BYTES} bytes`,
          );
        }
        streamBytes += value.byteLength;
        feedSseChunk(acc, decoder.decode(value, { stream: true }), onDelta, onReasoningDelta);
        if (acc.done) {
          // [DONE] is the protocol terminator. Do not wait for a peer that keeps
          // the transport open, and do not accept trailing bytes as deltas.
          await reader.cancel().catch(() => {});
          break;
        }
      }
      feedSseChunk(acc, decoder.decode(), onDelta, onReasoningDelta);
    } catch (err) {
      // A stall (or any read error) leaves a pending read — cancel to settle it
      // and tear down the connection, then propagate.
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
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
