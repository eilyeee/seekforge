import { afterEach, describe, expect, it } from "vitest";
import { createDeepSeekProvider } from "../../src/provider/index.js";
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
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
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
              : ((sent = true), {
                  done: false,
                  value: enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
                }),
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
});
