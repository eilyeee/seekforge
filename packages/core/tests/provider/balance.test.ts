import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBalance } from "../../src/provider/balance.js";

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
});
