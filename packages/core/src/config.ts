/**
 * Config keys whose meaning core and the shared merge own rather than any one
 * frontend. Every surface honors them identically — the key comes out of
 * `mergeConfigLayers` already applied — so no frontend wires them by hand, and
 * they are declared once here instead of in each `<Surface>Config`.
 *
 * A frontend config type that wants to read one intersects this type.
 */

import { normalizeApiKeyHelper } from "@seekforge/shared/api-key-helper";

export type CoreConfig = {
  /**
   * Shell command whose stdout (trimmed) is the provider API key. User-owned
   * layers only: a repository layer that names one is ignored, because it runs
   * a command. Re-run after SEEKFORGE_API_KEY_HELPER_TTL_MS and once on a 401.
   */
  apiKeyHelper?: string;
};

/**
 * Problems with the core-owned keys of one parsed config layer, for a doctor
 * line. A malformed `apiKeyHelper` is otherwise just ignored, which reads as
 * "no API key" with no hint why.
 */
export function coreConfigIssues(layer: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (Object.hasOwn(layer, "apiKeyHelper") && normalizeApiKeyHelper(layer["apiKeyHelper"]) === undefined) {
    issues.push("apiKeyHelper must be a non-empty string (a shell command that prints the API key)");
  }
  return issues;
}
