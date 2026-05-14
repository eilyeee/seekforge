/**
 * First-run onboarding logic (pure). Mirrors apps/tui/src/onboarding.ts but
 * persists through the existing /api/config path (no direct filesystem IO in
 * the desktop app). Decides when to show the wizard and validates key shape —
 * never calls the network.
 */
import type { ServerConfig } from "../types";

/** True when no API key is configured (server reports an empty/absent key). */
export function needsOnboarding(config: Pick<ServerConfig, "apiKey">): boolean {
  return !config.apiKey || config.apiKey.trim() === "";
}

/**
 * Cheap format check on a candidate API key (trimmed first). Returns a
 * human-readable error message, or null when the key looks plausible.
 * Deliberately does NOT verify the key against the API.
 */
export function validateApiKeyFormat(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "API key is empty";
  if (/\s/.test(trimmed)) return "API key must not contain whitespace";
  if (trimmed.length < 20) return "API key looks too short (expected at least 20 characters)";
  if (trimmed.length > 200) return "API key looks too long (expected at most 200 characters)";
  return null;
}
