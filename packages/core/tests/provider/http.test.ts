import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../../src/provider/http.js";
import type { RetryInfo } from "../../src/provider/index.js";

/** Builds a minimal Response-like stub for the retry loop. */
function res(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("fetchWithRetry onRetry", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Make the backoff sleep resolve immediately so the test is fast.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  /**
   * Drives fetchWithRetry to completion while flushing the fake timers.
   * Attaches a no-op catch first so a rejecting promise never registers as an
   * unhandled rejection during the timer flush.
   */
  function runWithTimers<T>(p: Promise<T>): Promise<T> {
    p.catch(() => {});
    return vi.runAllTimersAsync().then(() => p);
  }

  it("fires onRetry with attempt/delay/reason on a 429-then-200 sequence", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(429, "slow down"))
      .mockResolvedValueOnce(res(200, "ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const retries: RetryInfo[] = [];
    const out = await runWithTimers(
      fetchWithRetry("https://x/y", { method: "POST" }, { onRetry: (i) => retries.push(i) }),
    );

    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3, reason: "rate limited" });
    expect(retries[0]!.delayMs).toBeGreaterThan(0);
  });

  it("reports the matching reason for a 5xx then a network error", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "down"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(res(200, "ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const retries: RetryInfo[] = [];
    await runWithTimers(fetchWithRetry("https://x/y", { method: "POST" }, { onRetry: (i) => retries.push(i) }));

    expect(retries.map((r) => r.reason)).toEqual(["server error (503)", "network error"]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("does not call onRetry on first-try success", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(200, "ok"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRetry = vi.fn();
    const out = await runWithTimers(fetchWithRetry("https://x/y", { method: "POST" }, { onRetry }));

    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("does not call onRetry for a non-retryable 4xx", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(400, "bad request"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRetry = vi.fn();
    await expect(runWithTimers(fetchWithRetry("https://x/y", { method: "POST" }, { onRetry }))).rejects.toThrow(
      /HTTP 400/,
    );
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("stops immediately when the caller aborts during retry backoff", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(503, "busy"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const request = fetchWithRetry(
      "https://x/y",
      { method: "POST", signal: controller.signal },
      { onRetry: () => controller.abort(reason) },
    );
    await expect(request).rejects.toBe(reason);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry timeout", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("aborts a hung request and surfaces a timeout (instead of hanging forever)", async () => {
    // fetch that never resolves until aborted — then rejects with the abort
    // reason, exactly like the real fetch does.
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

    await expect(fetchWithRetry("https://x/y", { method: "POST" }, { maxRetries: 0, timeoutMs: 20 })).rejects.toThrow(
      /timed out/,
    );
  });

  it("does NOT abort the body after headers arrive (TTFB-only; streaming is safe)", async () => {
    // Fake timers make "the timeout window elapsed" deterministic instead of
    // racing a real 20ms timer against a wall-clock sleep on a loaded runner.
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      globalThis.fetch = ((_url: string, init: RequestInit) => {
        captured = init.signal ?? undefined;
        return Promise.resolve(res(200, "ok")); // response/headers resolve immediately
      }) as unknown as typeof fetch;

      const r = await fetchWithRetry("https://x/y", { method: "POST" }, { timeoutMs: 20 });
      expect(r.status).toBe(200);
      // Past the timeout window: the timer was cleared on success, so the signal a
      // streaming body would read from is still live (never aborted).
      await vi.advanceTimersByTimeAsync(50);
      expect(captured?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the timeout while a successful non-streaming body is stalled", async () => {
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          }),
      } as Response)) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://x/y",
      { method: "POST" },
      { maxRetries: 0, timeoutMs: 20, timeoutBody: true },
    );
    await expect(response.json()).rejects.toThrow(/timed out/);
  });

  it("honors caller cancellation while consuming a successful response body", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled during body read");
    globalThis.fetch = ((_url: string, init: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
          }),
      } as Response)) as unknown as typeof fetch;

    const response = await fetchWithRetry(
      "https://x/y",
      { method: "POST", signal: controller.signal },
      { maxRetries: 0, timeoutMs: 10_000, timeoutBody: true },
    );
    const body = response.json();
    controller.abort(reason);
    await expect(body).rejects.toBe(reason);
  });
});
