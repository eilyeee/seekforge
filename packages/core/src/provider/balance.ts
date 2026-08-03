import { DEFAULT_BASE_URL } from "./constants.js";
import { readJsonResponseBounded } from "./http.js";
import { resolveProviderPreset } from "./presets.js";
import { resolveWireProtocol } from "./protocols/index.js";

const BALANCE_TIMEOUT_MS = 10_000;

/** Account balance as reported by the DeepSeek platform. */
export type AccountBalance = {
  /** Billing currency, e.g. "USD" or "CNY". */
  currency: string;
  /** Total remaining balance as a decimal string (the API's own format). */
  totalBalance: string;
};

export type ProviderAccessCheck =
  | { ok: true }
  | { ok: false; reason: "invalid_credentials" | "provider_error" | "unreachable" };

/**
 * One GET against an endpoint that authenticates but does not generate. The
 * response body is deliberately ignored and cancelled: onboarding needs an
 * auth/connectivity signal, not account data.
 */
async function probe(url: string, headers: Record<string, string>): Promise<ProviderAccessCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal, headers });
    await res.body?.cancel().catch(() => {});
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: "invalid_credentials" };
    return { ok: false, reason: "provider_error" };
  } catch {
    return { ok: false, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifies that a DeepSeek key can authenticate without starting a billable
 * chat completion.
 */
export async function verifyDeepSeekAccess(apiKey: string, baseUrl?: string): Promise<ProviderAccessCheck> {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  return probe(`${base}/user/balance`, { authorization: `Bearer ${apiKey}` });
}

/**
 * Verifies a key against the provider it belongs to.
 *
 * A credential is scoped to the endpoint that issued it, so the check has to
 * follow the configured provider: sending an Ark or Anthropic key to DeepSeek's
 * account endpoint hands that secret to a vendor it was never issued for, and
 * then reports the inevitable rejection as if the key were bad. The endpoint
 * and the auth header both come from what the provider speaks — `/user/balance`
 * exists only on DeepSeek; every other preset answers the models listing its
 * own protocol defines.
 *
 * SECURITY. The destination is derived from the PRESET — a constant compiled
 * into SeekForge — precisely so a config file cannot choose where a secret is
 * sent. `baseUrl` overrides that and must therefore only ever be passed from a
 * trusted layer (a user's own global config), never from a project's
 * `.seekforge/config.json`, which any repository can write. An unrecognized
 * provider name has no trusted destination at all and falls back to the
 * default endpoint rather than guessing one from configuration.
 */
export async function verifyProviderAccess(input: {
  apiKey: string;
  provider?: string;
  /** Only from a trusted config layer — see the security note above. */
  baseUrl?: string;
}): Promise<ProviderAccessCheck> {
  const preset = resolveProviderPreset(input.provider ?? "deepseek");
  const base = (input.baseUrl ?? preset?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  // The protocol's own auth: a bearer token on the OpenAI-compatible line,
  // x-api-key plus a version header on Anthropic's.
  const headers = resolveWireProtocol(preset?.protocol).headers(input.apiKey);
  const balanceEndpoint = preset === undefined || preset.capabilities.balance;
  return probe(balanceEndpoint ? `${base}/user/balance` : `${base}/models`, headers);
}

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
    const json = (await readJsonResponseBounded(res)) as {
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
