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
});
