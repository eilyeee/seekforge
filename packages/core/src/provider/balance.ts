import { DEFAULT_BASE_URL } from "./constants.js";

const BALANCE_TIMEOUT_MS = 10_000;

/** Account balance as reported by the DeepSeek platform. */
export type AccountBalance = {
  /** Billing currency, e.g. "USD" or "CNY". */
  currency: string;
  /** Total remaining balance as a decimal string (the API's own format). */
  totalBalance: string;
};

/**
 * Fetches the DeepSeek account balance (GET {base}/user/balance).
 *
 * The endpoint returns `{ is_available, balance_infos: [{ currency,
 * total_balance, ... }] }`; the first entry is the primary currency.
 * Defensive by design: returns null on ANY failure (network, auth, timeout,
 * unexpected shape) — callers should treat null as "balance unknown" and
 * keep showing the previous value, never fail the session over it.
 */
export async function fetchBalance(apiKey: string, baseUrl?: string): Promise<AccountBalance | null> {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/user/balance`, {
      method: "GET",
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      balance_infos?: { currency?: unknown; total_balance?: unknown }[];
    };
    const info = json?.balance_infos?.[0];
    if (!info || typeof info.currency !== "string" || typeof info.total_balance !== "string") {
      return null;
    }
    return { currency: info.currency, totalBalance: info.total_balance };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
