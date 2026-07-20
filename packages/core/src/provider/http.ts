/**
 * fetch with retries for the DeepSeek API.
 * 429 and 5xx (and network errors) retry with exponential backoff + jitter;
 * other 4xx fail immediately. Error messages include a response-body snippet
 * but NEVER the API key (it only ever lives in the request headers).
 */

import type { RetryInfo } from "./types.js";
import { onAbortOnce } from "../util/abort.js";
import { MAX_PROVIDER_RESPONSE_BYTES } from "./protocol-limits.js";

const MAX_RETRIES = 3;
const MAX_CONFIGURED_RETRIES = 10;
const BASE_DELAY_MS = 500;
const BODY_SNIPPET_CHARS = 500;
/**
 * Per-request timeout. Without one, a dropped/hung connection blocks the run
 * forever; with it, the attempt aborts and the normal retry loop takes over.
 * Generous so it never cuts off a legitimately long (non-streaming) generation.
 */
const REQUEST_TIMEOUT_MS = 180_000;

export type FetchWithRetryOptions = {
  /** Reported just before each backoff sleep (attempt is 1-based). */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Override the retry budget (default MAX_RETRIES). Pass 0 to disable retries
   * entirely — used by the provider's fallback-model path, which wants exactly
   * one attempt with the alternate model.
   */
  maxRetries?: number;
  /** Per-request timeout in ms (default REQUEST_TIMEOUT_MS); a hung request aborts and retries. */
  timeoutMs?: number;
  /** Keep the request timeout armed until a successful response body is consumed. */
  timeoutBody?: boolean;
};

export type ResponseHandler<T> = (response: Response) => Promise<T>;

const BODY_CONSUMERS = new Set<PropertyKey>(["arrayBuffer", "blob", "bytes", "formData", "json", "text"]);

function withBodyTimeout(response: Response, cleanup: () => void): Response {
  return new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function") return value;
      if (!BODY_CONSUMERS.has(property)) return value.bind(target) as unknown;
      return async (...args: unknown[]) => {
        try {
          return await Reflect.apply(value, target, args);
        } finally {
          cleanup();
        }
      };
    },
  });
}

/** Short human-readable cause for a retry, used in the onRetry report. */
function retryReason(status: number | undefined): string {
  if (status === 429) return "rate limited";
  if (status !== undefined && status >= 500) return `server error (${status})`;
  return "network error";
}

export class DeepSeekApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeepSeekApiError";
  }
}

export class ProviderResponseTooLargeError extends DeepSeekApiError {
  constructor(limit: number) {
    super(`provider response body exceeds ${limit} bytes`, 413);
    this.name = "ProviderResponseTooLargeError";
  }
}

/** Reads and parses a successful JSON body without allowing unbounded buffering. */
export async function readJsonResponseBounded(
  response: Response,
  limit = MAX_PROVIDER_RESPONSE_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError(`provider response byte limit must be a non-negative safe integer: ${limit}`);
  }
  if (!response.body) return await response.json();
  const declared = Number(response.headers?.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel().catch(() => {});
    throw new ProviderResponseTooLargeError(limit);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - bytes) {
        await reader.cancel().catch(() => {});
        throw new ProviderResponseTooLargeError(limit);
      }
      bytes += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data)) as unknown;
}

async function readErrorSnippet(response: Response): Promise<string> {
  if (!response.body) return (await response.text().catch(() => "")).slice(0, BODY_SNIPPET_CHARS);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < BODY_SNIPPET_CHARS * 4) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = BODY_SNIPPET_CHARS * 4 - bytes;
      chunks.push(value.subarray(0, remaining));
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining) break;
    }
    await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(data).slice(0, BODY_SNIPPET_CHARS);
}

/**
 * True if a DeepSeekApiError represents the same retryable condition that
 * fetchWithRetry retries on (429 / 5xx / network). A DeepSeekApiError with no
 * status is a network error (also retryable); other 4xx (400/401/403/etc.) are
 * not. Used by the provider's fallback-model path to decide whether the
 * exhausted-retries failure warrants a final fallback attempt.
 */
export function isRetryableError(err: unknown): boolean {
  if (!(err instanceof DeepSeekApiError)) return false;
  const { status } = err;
  return status === undefined || status === 429 || status >= 500;
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offAbort();
      resolve();
    }, ms);
    const offAbort = onAbortOnce(signal ?? undefined, () => {
      clearTimeout(timer);
      reject(signal?.reason);
    });
  });
}

function backoffMs(attempt: number): number {
  // attempt is 1-based for retries: 500ms, 1s, 2s (+ up to 250ms jitter)
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

/** Cap on an honored Retry-After so a hostile/huge header can't stall a run. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Parse an HTTP `Retry-After` header (delta-seconds or an HTTP-date) into a
 * delay in ms, bounded by MAX_RETRY_AFTER_MS. Returns undefined for a missing,
 * malformed, or already-elapsed value so the caller falls back to exponential
 * backoff.
 */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  const delta = at - nowMs;
  return delta > 0 ? Math.min(delta, MAX_RETRY_AFTER_MS) : undefined;
}

export function fetchWithRetry(url: string, init: RequestInit, options?: FetchWithRetryOptions): Promise<Response>;
export function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions,
  handleResponse: ResponseHandler<T>,
): Promise<T>;
export async function fetchWithRetry<T>(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
  handleResponse?: ResponseHandler<T>,
): Promise<Response | T> {
  let lastError: Error = new DeepSeekApiError("request never attempted");
  // Cause of the failure that scheduled the upcoming retry (status undefined =
  // network error). Carried across iterations so onRetry reports it precisely.
  let pendingStatus: number | undefined;
  // A Retry-After the server asked us to wait (ms), honored in place of the
  // exponential backoff for the next attempt. Undefined = use backoff.
  let pendingRetryAfterMs: number | undefined;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_CONFIGURED_RETRIES) {
    throw new RangeError(`provider maxRetries must be an integer between 0 and ${MAX_CONFIGURED_RETRIES}`);
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("provider timeoutMs must be finite and between 1 and 2147483647");
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = pendingRetryAfterMs ?? backoffMs(attempt);
      try {
        options.onRetry?.({
          attempt,
          maxAttempts: maxRetries,
          delayMs: Math.round(delayMs),
          reason: retryReason(pendingStatus),
        });
      } catch {
        // A misbehaving frontend callback must never break the request path.
      }
      await sleep(delayMs, init.signal);
    }
    let res: Response;
    // Timeout guards time-to-headers only, then is cleared — so a long but
    // progressing STREAMING body (chatStream) is never aborted mid-stream. A
    // hung connection that never sends headers still aborts and retries. Compose
    // with any caller signal (e.g. cancel) so cancellation still aborts the body.
    const controller = new AbortController();
    const timeoutErr = Object.assign(new Error(`request timed out after ${timeoutMs}ms`), {
      name: "TimeoutError",
    });
    const onCallerAbort = (): void => clearTimeout(timer);
    init.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      init.signal?.removeEventListener("abort", onCallerAbort);
      controller.abort(timeoutErr);
    }, timeoutMs);
    const clearAttemptTimeout = (): void => {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    };
    try {
      const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
      res = await fetch(url, { ...init, signal });
    } catch (err) {
      clearAttemptTimeout();
      if (init.signal?.aborted) throw init.signal.reason;
      const timedOut = err === timeoutErr;
      lastError = new DeepSeekApiError(
        timedOut
          ? `DeepSeek API request timed out after ${timeoutMs}ms`
          : `network error calling DeepSeek API: ${err instanceof Error ? err.message : String(err)}`,
      );
      pendingStatus = undefined;
      pendingRetryAfterMs = undefined;
      continue;
    }
    if (res.ok) {
      if (handleResponse) {
        // Parse non-streaming bodies inside the attempt so post-header failures
        // participate in the same retry and fallback policy. The timer stays
        // armed across the body read: disarming first would let a stalled body
        // hang forever with no abort path (same reasoning as the error-body
        // read below).
        try {
          const result = await handleResponse(res);
          clearAttemptTimeout();
          return result;
        } catch (err) {
          clearAttemptTimeout();
          if (init.signal?.aborted) throw init.signal.reason;
          if (err instanceof ProviderResponseTooLargeError) throw err;
          const timedOut = err === timeoutErr;
          lastError = new DeepSeekApiError(
            timedOut
              ? `DeepSeek API response body timed out after ${timeoutMs}ms`
              : `network error reading DeepSeek API response: ${err instanceof Error ? err.message : String(err)}`,
          );
          pendingStatus = undefined;
          pendingRetryAfterMs = undefined;
          continue;
        }
      }
      if (options.timeoutBody) return withBodyTimeout(res, clearAttemptTimeout);
      clearAttemptTimeout(); // streaming bodies use their own idle timeout
      return res;
    }
    // Error response: keep the timer armed while reading the (bounded) error
    // body. clearing it first would leave the read with no abort path, so a
    // server that sends error headers but stalls the body would hang forever.
    const retryAfter = parseRetryAfter(res.headers?.get("retry-after") ?? null);
    const snippet = await readErrorSnippet(res).catch(() => "");
    clearAttemptTimeout();
    if (init.signal?.aborted) throw init.signal.reason;
    const message = `DeepSeek API error HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new DeepSeekApiError(message, res.status);
    lastError = new DeepSeekApiError(message, res.status);
    pendingStatus = res.status;
    // Honor the server's stated wait for the next attempt (e.g. a 429 asking us
    // to back off 30s) instead of the fixed exponential schedule.
    pendingRetryAfterMs = retryAfter;
  }
  throw lastError;
}
