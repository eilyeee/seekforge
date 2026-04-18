import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * First-run onboarding logic: decide when to show the API-key wizard,
 * validate key shape (format only — never calls the network), and persist
 * the key into the global ~/.seekforge/config.json. Pure/injectable so the
 * IO is testable against a tmpdir homeDir.
 */

/** True when no API key is configured anywhere (env/project/global). */
export function needsOnboarding(config: { apiKey?: string }): boolean {
  return !config.apiKey;
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

/**
 * Merge { apiKey } into <home>/.seekforge/config.json, preserving any other
 * fields and creating the directory/file when missing. Written with mode
 * 0600 — the file holds a secret. Returns the path written.
 */
export function saveGlobalApiKey(key: string, homeDir: string = homedir()): { path: string } {
  const dir = join(homeDir, ".seekforge");
  const path = join(dir, "config.json");
  mkdirSync(dir, { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or corrupt file: start fresh
  }
  const merged = { ...existing, apiKey: key.trim() };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { path };
}
