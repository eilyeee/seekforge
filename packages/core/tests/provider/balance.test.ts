import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalance, verifyDeepSeekAccess, verifyProviderAccess } from "../../src/provider/balance.js";
import { MAX_PROVIDER_RESPONSE_BYTES } from "../../src/provider/protocol-limits.js";

function fetchReturning(json: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => ({ ok, status, json: async () => json }));
  vi.stubGlobal("fetch", spy as unknown as typeof fetch);
  return spy;
}

describe("fetchBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("parses the DeepSeek balance shape", async () => {
    const spy = fetchReturning({
      is_available: true,
      balance_infos: [{ currency: "USD", total_balance: "42.50", granted_balance: "0.00", topped_up_balance: "42.50" }],
    });
    const balance = await fetchBalance("sk-test");
    expect(balance).toEqual({ currency: "USD", totalBalance: "42.50" });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("honors a custom base URL and strips trailing slashes", async () => {
    const spy = fetchReturning({ balance_infos: [{ currency: "CNY", total_balance: "1.00" }] });
    await fetchBalance("sk-test", "https://proxy.example/v1/");
    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://proxy.example/v1/user/balance");
  });

  it.each([
    ["empty object", {}],
    ["empty balance_infos", { balance_infos: [] }],
    ["wrong field types", { balance_infos: [{ currency: 1, total_balance: 2 }] }],
    ["missing total_balance", { balance_infos: [{ currency: "USD" }] }],
    ["null body", null],
  ])("returns null on malformed payload: %s", async (_name, payload) => {
    fetchReturning(payload);
    expect(await fetchBalance("sk-test")).toBeNull();
  });

  it("returns null on HTTP error", async () => {
    fetchReturning({}, false, 401);
    expect(await fetchBalance("bad-key")).toBeNull();
  });

  it("returns null when the request throws (network failure)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    );
    expect(await fetchBalance("sk-test")).toBeNull();
  });

  it("rejects a declared oversized body and cancels it without buffering", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-length": String(MAX_PROVIDER_RESPONSE_BYTES + 1) },
          }),
      ) as unknown as typeof fetch,
    );

    expect(await fetchBalance("sk-test")).toBeNull();
    expect(cancelled).toBe(true);
  });
});

describe("verifyDeepSeekAccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("accepts a successful non-billable account request", async () => {
    fetchReturning({}, true, 200);
    await expect(verifyDeepSeekAccess("sk-test")).resolves.toEqual({ ok: true });
  });

  it.each([401, 403])("classifies HTTP %s as invalid credentials", async (status) => {
    fetchReturning({}, false, status);
    await expect(verifyDeepSeekAccess("sk-invalid")).resolves.toEqual({ ok: false, reason: "invalid_credentials" });
  });

  it("distinguishes provider errors from connectivity errors", async () => {
    fetchReturning({}, false, 503);
    await expect(verifyDeepSeekAccess("sk-test")).resolves.toEqual({ ok: false, reason: "provider_error" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    await expect(verifyDeepSeekAccess("sk-test")).resolves.toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("verifyProviderAccess", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const called = (spy: ReturnType<typeof vi.fn>): [string, RequestInit] =>
    spy.mock.calls[0] as unknown as [string, RequestInit];

  it("checks a DeepSeek key against DeepSeek", async () => {
    const spy = fetchReturning({}, true, 200);
    await expect(verifyProviderAccess({ apiKey: "sk-test" })).resolves.toEqual({ ok: true });
    const [url, init] = called(spy);
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("never sends another provider's key to DeepSeek", async () => {
    // The key belongs to the endpoint that issued it. Probing DeepSeek with an
    // Ark key hands the secret to a vendor it was not issued for, and the
    // rejection that follows then reads as "your key is invalid".
    const spy = fetchReturning({}, true, 200);
    await verifyProviderAccess({ apiKey: "ark-key", provider: "ark" });
    const [url, init] = called(spy);
    expect(url).toBe("https://ark.cn-beijing.volces.com/api/plan/v3/models");
    expect(url).not.toContain("deepseek");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ark-key");
  });

  it("authenticates the way the provider's own protocol does", async () => {
    const spy = fetchReturning({}, true, 200);
    await verifyProviderAccess({ apiKey: "sk-ant-key", provider: "anthropic" });
    const [url, init] = called(spy);
    expect(url).toBe("https://api.anthropic.com/v1/models");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("honors an explicit base URL over the preset's", async () => {
    // Only a trusted caller may pass one: the preset is a compiled-in constant,
    // a baseUrl is configuration, and configuration must not be able to choose
    // where a secret is sent (see the server route, which never forwards it).
    const spy = fetchReturning({}, true, 200);
    await verifyProviderAccess({ apiKey: "k", provider: "anthropic", baseUrl: "https://proxy.example/v1/" });
    expect(called(spy)[0]).toBe("https://proxy.example/v1/models");
  });

  it("falls back to the default endpoint for a provider it does not recognize", async () => {
    // Nothing trustworthy says where an unknown provider lives, and guessing
    // from configuration is the one thing this must not do.
    const spy = fetchReturning({}, true, 200);
    await verifyProviderAccess({ apiKey: "k", provider: "acme-unknown" });
    expect(called(spy)[0]).toBe("https://api.deepseek.com/user/balance");
  });

  it("classifies rejection, provider failure, and unreachability apart", async () => {
    fetchReturning({}, false, 401);
    await expect(verifyProviderAccess({ apiKey: "bad", provider: "anthropic" })).resolves.toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    fetchReturning({}, false, 503);
    await expect(verifyProviderAccess({ apiKey: "k", provider: "anthropic" })).resolves.toEqual({
      ok: false,
      reason: "provider_error",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    );
    await expect(verifyProviderAccess({ apiKey: "k", provider: "anthropic" })).resolves.toEqual({
      ok: false,
      reason: "unreachable",
    });
  });
});
