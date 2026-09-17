import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { writeStateFile } from "./state-file.js";

/**
 * First-run onboarding logic: decide when to show the API-key wizard,
 * validate key shape (format only — never calls the network), and persist
 * the key into the global ~/.seekforge/config.json. Pure/injectable so the
 * IO is testable against a tmpdir homeDir.
 */

/**
 * True when no API key is configured anywhere (env/project/global) and no
 * `apiKeyHelper` is there to supply one — a key the wizard saves would never
 * be used beside a helper, which replaces the file key.
 */
export function needsOnboarding(config: { apiKey?: string; apiKeyHelper?: string }): boolean {
  return !config.apiKey && !config.apiKeyHelper;
}

/** What the launcher does about the API key before the screen is taken. */
export type KeySetup = { kind: "ready" } | { kind: "wizard" } | { kind: "helper-failed"; message: string };

/**
 * `helperError` is the config merge's report of a failed `apiKeyHelper`. A
 * configured helper that failed is reported as that failure — the wizard
 * would save a key the helper then overrides.
 */
export function keySetup(config: { apiKey?: string; apiKeyHelper?: string }, helperError?: string): KeySetup {
  if (config.apiKey) return { kind: "ready" };
  if (config.apiKeyHelper) {
    return helperError !== undefined ? { kind: "helper-failed", message: helperError } : { kind: "ready" };
  }
  return { kind: "wizard" };
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
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`existing config is not a JSON object: ${path}`);
    }
    existing = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`refusing to replace unreadable or invalid config: ${path}`, { cause: error });
    }
  }
  const merged = { ...existing, apiKey: key.trim() };
  writeStateFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { path };
}
