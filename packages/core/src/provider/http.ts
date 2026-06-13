/**
 * fetch with retries for the DeepSeek API.
 * 429 and 5xx (and network errors) retry with exponential backoff + jitter;
 * other 4xx fail immediately. Error messages include a response-body snippet
 * but NEVER the API key (it only ever lives in the request headers).
 */

import type { RetryInfo } from "./types.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const BODY_SNIPPET_CHARS = 500;

export type FetchWithRetryOptions = {
  /** Reported just before each backoff sleep (attempt is 1-based). */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Override the retry budget (default MAX_RETRIES). Pass 0 to disable retries
   * entirely — used by the provider's fallback-model path, which wants exactly
   * one attempt with the alternate model.
   */
  maxRetries?: number;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number): number {
  // attempt is 1-based for retries: 500ms, 1s, 2s (+ up to 250ms jitter)
  return BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  let lastError: Error = new DeepSeekApiError("request never attempted");
  // Cause of the failure that scheduled the upcoming retry (status undefined =
  // network error). Carried across iterations so onRetry reports it precisely.
  let pendingStatus: number | undefined;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = backoffMs(attempt);
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
      await sleep(delayMs);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastError = new DeepSeekApiError(
        `network error calling DeepSeek API: ${err instanceof Error ? err.message : String(err)}`,
      );
      pendingStatus = undefined;
      continue;
    }
    if (res.ok) return res;
    const snippet = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_CHARS);
    const message = `DeepSeek API error HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new DeepSeekApiError(message, res.status);
    lastError = new DeepSeekApiError(message, res.status);
    pendingStatus = res.status;
  }
  throw lastError;
}
