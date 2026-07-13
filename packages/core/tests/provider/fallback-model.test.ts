import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
import type { RetryInfo } from "../../src/provider/index.js";

/** Minimal Response-like stub for the fetch mock. */
function res(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  } as unknown as Response;
}

/** A successful chat-completion wire payload echoing which model answered. */
function completion(model: string): Response {
  return res(200, {
    choices: [{ message: { content: `hi from ${model}` }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

/** Parses the `model` field out of a fetch call's JSON body. */
function bodyModel(call: Parameters<typeof fetch>): string {
  const init = call[1] as RequestInit;
  return (JSON.parse(init.body as string) as { model: string }).model;
}

const REQ = { messages: [{ role: "user" as const, content: "hello" }] };

describe("createDeepSeekProvider fallbackModel", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    // Collapse the retry backoff sleeps so the test runs instantly.
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function withTimers<T>(p: Promise<T>): Promise<T> {
    p.catch(() => {});
    return vi.runAllTimersAsync().then(() => p);
  }

  it("(a) with no fallbackModel, a retryable failure throws after retries exhaust", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(503, "down"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k", model: "deepseek-v4-flash" });
    await expect(withTimers(provider.chat(REQ))).rejects.toThrow(/HTTP 503/);

    // 1 initial + 3 retries = 4 attempts, all against the primary model.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) {
      expect(bodyModel(call)).toBe("deepseek-v4-flash");
    }
  });

  it("(b) with fallbackModel set, retries the fallback once and succeeds", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      // primary: 4 retryable failures, then the fallback attempt succeeds.
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(completion("deepseek-v4-pro"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-pro",
    });
    const out = await withTimers(provider.chat(REQ));

    expect(out.content).toBe("hi from deepseek-v4-pro");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // First four use the primary, the fifth (fallback) uses the fallback model.
    for (let i = 0; i < 4; i++) {
      expect(bodyModel(fetchMock.mock.calls[i]!)).toBe("deepseek-v4-flash");
    }
    expect(bodyModel(fetchMock.mock.calls[4]!)).toBe("deepseek-v4-pro");
  });

  it("prices a non-streaming fallback response using the fallback model", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(completion("fallback-priced"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "primary-priced",
      fallbackModel: "fallback-priced",
      modelPricing: {
        "primary-priced": { inputCacheMissPer1M: 1, inputCacheHitPer1M: 1, outputPer1M: 1 },
        "fallback-priced": { inputCacheMissPer1M: 7, inputCacheHitPer1M: 7, outputPer1M: 11 },
      },
    });
    const out = await withTimers(provider.chat(REQ));

    expect(out.usage.costUsd).toBeCloseTo((7 + 11) / 1_000_000, 12);
  });

  it("(c) onRetry fires with the fallback model name when falling back", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(completion("deepseek-v4-pro"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const notices: RetryInfo[] = [];
    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-pro",
      onRetry: (i) => notices.push(i),
    });
    await withTimers(provider.chat(REQ));

    const fallbackNotice = notices.find((n) => n.fallbackModel !== undefined);
    expect(fallbackNotice).toBeDefined();
    expect(fallbackNotice!.fallbackModel).toBe("deepseek-v4-pro");
    // Ordinary same-model retries carry no fallbackModel.
    expect(notices.filter((n) => n.fallbackModel === undefined)).toHaveLength(3);
  });

  it("does not fall back on a non-retryable 4xx; throws immediately", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(401, "bad key"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const onRetry = vi.fn();
    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-pro",
      onRetry,
    });
    await expect(withTimers(provider.chat(REQ))).rejects.toThrow(/HTTP 401/);

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries, no fallback
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("throws the ORIGINAL error when the fallback attempt also fails", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "primary down"))
      .mockResolvedValueOnce(res(503, "primary down"))
      .mockResolvedValueOnce(res(503, "primary down"))
      .mockResolvedValueOnce(res(503, "primary down"))
      .mockResolvedValueOnce(res(500, "fallback down too"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-pro",
    });
    // Original 503 surfaces, not the fallback's 500.
    await expect(withTimers(provider.chat(REQ))).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("skips fallback entirely when fallbackModel equals the active model", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(res(503, "down"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-flash",
    });
    await expect(withTimers(provider.chat(REQ))).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(4); // primary only, no extra attempt
  });

  it("falls back on the streaming path too", async () => {
    const stream = (model: string): Response => {
      const payload =
        `data: {"choices":[{"delta":{"content":"hi from ${model}"}}]}\n\n` + "data: [DONE]\n\n";
      return {
        ok: true,
        status: 200,
        text: async () => payload,
        body: {
          getReader() {
            let sent = false;
            return {
              read: async () =>
                sent
                  ? { done: true, value: undefined }
                  : ((sent = true), { done: false, value: new TextEncoder().encode(payload) }),
              releaseLock() {},
            };
          },
        },
      } as unknown as Response;
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(stream("deepseek-v4-pro"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const deltas: string[] = [];
    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "deepseek-v4-flash",
      fallbackModel: "deepseek-v4-pro",
    });
    const out = await withTimers(provider.chatStream(REQ, (c) => deltas.push(c)));

    expect(out.content).toBe("hi from deepseek-v4-pro");
    expect(deltas.join("")).toBe("hi from deepseek-v4-pro");
    expect(bodyModel(fetchMock.mock.calls[4]!)).toBe("deepseek-v4-pro");
  });

  it("prices a streaming fallback response using the fallback model", async () => {
    const payload = [
      'data: {"choices":[{"delta":{"content":"fallback"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const stream = {
      ok: true,
      status: 200,
      body: new Response(payload).body,
    } as Response;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(res(503, "down"))
      .mockResolvedValueOnce(stream);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      model: "primary-priced",
      fallbackModel: "fallback-priced",
      modelPricing: {
        "primary-priced": { inputCacheMissPer1M: 1, inputCacheHitPer1M: 1, outputPer1M: 1 },
        "fallback-priced": { inputCacheMissPer1M: 5, inputCacheHitPer1M: 5, outputPer1M: 13 },
      },
    });
    const out = await withTimers(provider.chatStream(REQ, () => {}));

    expect(out.usage.costUsd).toBeCloseTo((2 * 5 + 3 * 13) / 1_000_000, 12);
  });
});
