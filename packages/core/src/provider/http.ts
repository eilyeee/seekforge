/**
 * fetch with retries for the DeepSeek API.
 * 429 and 5xx (and network errors) retry with exponential backoff + jitter;
 * other 4xx fail immediately. Error messages include a response-body snippet
 * but NEVER the API key (it only ever lives in the request headers).
 */

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;
const BODY_SNIPPET_CHARS = 500;

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

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error = new DeepSeekApiError("request never attempted");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastError = new DeepSeekApiError(
        `network error calling DeepSeek API: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    if (res.ok) return res;
    const snippet = (await res.text().catch(() => "")).slice(0, BODY_SNIPPET_CHARS);
    const message = `DeepSeek API error HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable) throw new DeepSeekApiError(message, res.status);
    lastError = new DeepSeekApiError(message, res.status);
  }
  throw lastError;
}
