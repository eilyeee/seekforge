/**
 * Which environment variable holds a provider's API key.
 *
 * A key is scoped to the endpoint that issued it, so the lookup has to be
 * provider-aware: someone who exports ARK_API_KEY for another tool must never
 * have it sent to DeepSeek, and vice versa.
 *
 * Only providers with their own entry are read from their own variable.
 * Everything else falls back to DEEPSEEK_API_KEY, which is what those presets
 * have always used — repointing them now would silently break a working setup
 * for anyone whose key already lives there.
 *
 * Browser-safe (a plain table, no process access), so the desktop bundle can
 * import it too.
 */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  ark: "ARK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

export const DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";

/** Case-insensitive; an unknown or unset provider reads the default variable. */
export function apiKeyEnvVar(provider: string | undefined): string {
  return PROVIDER_API_KEY_ENV[(provider ?? "").toLowerCase()] ?? DEFAULT_API_KEY_ENV;
}
