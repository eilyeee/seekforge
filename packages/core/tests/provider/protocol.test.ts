import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepSeekProvider, ProviderProtocolError } from "../../src/provider/index.js";

describe("provider protocol validation", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it.each([
    ["error payload", { error: { message: "request rejected" } }],
    ["missing choices", { usage: { prompt_tokens: 1 } }],
  ])("treats HTTP 200 %s as a protocol error", async (_label, body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => body,
    } as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const provider = createDeepSeekProvider({ apiKey: "tenant-key" });

    await expect(provider.chat({ messages: [{ role: "user", content: "hello" }] })).rejects.toBeInstanceOf(
      ProviderProtocolError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes endpoint and tenant-relevant configuration in cacheIdentity", () => {
    const a = createDeepSeekProvider({ apiKey: "tenant-a", baseUrl: "https://one.example/v1" });
    const b = createDeepSeekProvider({ apiKey: "tenant-b", baseUrl: "https://one.example/v1" });
    const c = createDeepSeekProvider({ apiKey: "tenant-a", baseUrl: "https://two.example/v1" });
    const same = createDeepSeekProvider({ apiKey: "tenant-a", baseUrl: "https://one.example/v1/" });

    expect(a.cacheIdentity).not.toBe(b.cacheIdentity);
    expect(a.cacheIdentity).not.toBe(c.cacheIdentity);
    expect(a.cacheIdentity).toBe(same.cacheIdentity);
  });
});
