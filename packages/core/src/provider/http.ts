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
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = backoffMs(attempt);
      try {
        options.onRetry?.({
          attempt,
          maxAttempts: MAX_RETRIES,
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
