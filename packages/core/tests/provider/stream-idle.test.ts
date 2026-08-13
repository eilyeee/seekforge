import { MAX_TIMER_DELAY_MS } from "@seekforge/shared/timers";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekProvider, MAX_SSE_STREAM_BYTES, ProviderProtocolError } from "../../src/provider/index.js";
import type { ChatRequest } from "../../src/provider/index.js";

const req: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

describe("chatStream mid-stream idle timeout", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("aborts a stalled stream (no bytes) instead of hanging, and cancels the reader", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => {}), // never resolves -> stall
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 30 });
    await expect(provider.chatStream(req, () => {})).rejects.toThrow(/stalled/);
    expect(cancelled).toBe(true);
  });

  it("streams normally when data flows (idle timeout does not fire)", async () => {
    const chunks = ['data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', "data: [DONE]\n\n"];
    let i = 0;
    const enc = new TextEncoder();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            i < chunks.length ? { done: false, value: enc.encode(chunks[i++]!) } : { done: true, value: undefined },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const deltas: string[] = [];
    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 30 });
    const out = await provider.chatStream(req, (c) => deltas.push(c));
    expect(deltas.join("")).toBe("hello");
    expect(out.content).toBe("hello");
  });

  it("returns and cancels the transport immediately after [DONE]", async () => {
    const enc = new TextEncoder();
    let reads = 0;
    let cancelled = false;
    let released = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            reads++;
            if (reads === 1) {
              return Promise.resolve({
                done: false,
                value: enc.encode('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n'),
              });
            }
            return new Promise<never>(() => {});
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 30 });
    await expect(provider.chatStream(req, () => {})).resolves.toMatchObject({ content: "done" });
    expect(reads).toBe(1);
    expect(cancelled).toBe(true);
    expect(released).toBe(true);
  });

  it("rejects EOF before the protocol terminator", async () => {
    const enc = new TextEncoder();
    let sent = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : (() => {
                  sent = true;
                  return {
                    done: false,
                    value: enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
                  };
                })(),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 30 });
    await expect(provider.chatStream(req, () => {})).rejects.toThrow(/before \[DONE\]/);
  });

  it("cancels an in-flight stream read with the caller signal", async () => {
    let cancelled = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => new Promise<never>(() => {}),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 10_000 });

    const response = provider.chatStream({ ...req, signal: controller.signal }, () => {});
    controller.abort(reason);

    await expect(response).rejects.toBe(reason);
    expect(cancelled).toBe(true);
  });

  it("times out a stream that keeps making progress and cancels its reader", async () => {
    let cancelled = false;
    const keepAlive = new TextEncoder().encode(": keepalive\n\n");
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise<{ done: false; value: Uint8Array }>((resolve) => {
              setTimeout(() => resolve({ done: false, value: keepAlive }), 5);
            }),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k", streamIdleTimeoutMs: 100, streamTimeoutMs: 30 });
    await expect(provider.chatStream(req, () => {})).rejects.toThrow(/streaming response timed out after 30ms/);
    expect(cancelled).toBe(true);
  });

  /**
   * The clamp site's negative control, stated as an effect.
   *
   * `streamTimeoutMs` comes from a config file, so a caller may legitimately
   * ask for "effectively never" — 30 days here. That is past what `setTimeout`
   * can hold, and unclamped the total-timeout timer fires on the next tick and
   * rejects the stream before a single byte is read: the most generous setting
   * available behaves as the strictest one possible. Asserting that some bound
   * exists would not catch this; only reading the stream does. The same shape
   * covers `streamIdleTimeoutMs`, whose timer is armed on every read.
   */
  it("streams to completion when the configured timeouts exceed what a timer can hold", async () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    expect(thirtyDaysMs).toBeGreaterThan(MAX_TIMER_DELAY_MS);
    const chunks = ['data: {"choices":[{"delta":{"content":"patient"}}]}\n\n', "data: [DONE]\n\n"];
    let i = 0;
    const enc = new TextEncoder();
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          // Each read takes a real tick, so an overflowed timer wins the race.
          read: () =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve(
                    i < chunks.length
                      ? { done: false, value: enc.encode(chunks[i++]!) }
                      : { done: true, value: undefined },
                  ),
                5,
              );
            }),
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({
      apiKey: "k",
      streamIdleTimeoutMs: thirtyDaysMs,
      streamTimeoutMs: thirtyDaysMs,
    });
    await expect(provider.chatStream(req, () => {})).resolves.toMatchObject({ content: "patient" });
  });

  it("rejects an oversized byte stream as a protocol error and cancels its reader", async () => {
    let cancelled = false;
    let sent = false;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () =>
            sent
              ? { done: true, value: undefined }
              : (() => {
                  sent = true;
                  return { done: false, value: new Uint8Array(MAX_SSE_STREAM_BYTES + 1) };
                })(),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {},
        }),
      },
    })) as unknown as typeof fetch;

    const provider = createDeepSeekProvider({ apiKey: "k" });
    await expect(provider.chatStream(req, () => {})).rejects.toBeInstanceOf(ProviderProtocolError);
    expect(cancelled).toBe(true);
  });
});
