/** Runtime config-key manifest shared by typo detection across frontends. */
export const COMMON_CONFIG_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "permissionRules",
  "mcpServers",
  "hooks",
  "sandbox",
  "compaction",
  "thinking",
  "reasoningEffort",
  "modelPricing",
  "inlineImages",
  "planModel",
  "escalateOnFailure",
  "memoryAutoApproveConfidence",
  "memoryMaintenance",
  "lintCommand",
  "autoLint",
  "editFormat",
  "locale",
  "runRetentionMaxCount",
  "runRetentionMaxAgeDays",
  // Tool-configuration keys: they configure BUILTIN tools (image_analyze, the
  // browser session), which every frontend runs. Surface-scoping them made the
  // CLI report them as unknown while the TUI honored them — the same file
  // working in one command and warned about in another.
  "visionModel",
  "browserProfile",
  // web_search's endpoint. Deliberately absent from PROJECT_PREFERENCE_KEYS in
  // config-layers.ts: a repository that could set it would choose what the
  // model reads back from a search.
  "webSearch",
] as const;

export const SURFACE_CONFIG_KEYS = {
  cli: [
    "maxCostUsd",
    "maxDurationSeconds",
    "verifyCommand",
    "autoVerify",
    "finalizeReview",
    "guardNoProgress",
    "profiles",
  ],
  tui: ["accent", "bell", "notify", "vim", "statusLine", "costBudgetUsd", "mouse", "llmCache", "routing"],
  server: ["models"],
} as const;

export type ConfigSurface = keyof typeof SURFACE_CONFIG_KEYS;

export function knownConfigKeys(surface: ConfigSurface): ReadonlySet<string> {
  return new Set([...COMMON_CONFIG_KEYS, ...SURFACE_CONFIG_KEYS[surface]]);
}

/** Every key any frontend honors. A key outside this set is the only real typo. */
export function allConfigKeys(): ReadonlySet<string> {
  return new Set([...COMMON_CONFIG_KEYS, ...Object.values(SURFACE_CONFIG_KEYS).flat()]);
}

/** Which surfaces honor `key`, in manifest order; empty when nothing does. */
export function surfacesForConfigKey(key: string): ConfigSurface[] {
  if ((COMMON_CONFIG_KEYS as readonly string[]).includes(key)) {
    return Object.keys(SURFACE_CONFIG_KEYS) as ConfigSurface[];
  }
  return (Object.keys(SURFACE_CONFIG_KEYS) as ConfigSurface[]).filter((surface) =>
    (SURFACE_CONFIG_KEYS[surface] as readonly string[]).includes(key),
  );
}

/** One key's standing on one surface. */
export type ConfigKeyVerdict =
  /** No frontend honors it — the typo case. */
  | { key: string; kind: "unknown" }
  /** A real key, honored by other frontends but not this one. */
  | { key: string; kind: "other-surface"; surfaces: ConfigSurface[] };

/**
 * Sort config keys into "typo" and "valid, just not here".
 *
 * The distinction exists because ONE `.seekforge/config.json` is read by the
 * CLI, the TUI and the server, while each validated against only its own key
 * list. So `seekforge doctor` told anyone who had configured the Desktop's
 * `models`, or the TUI's `accent`, that their working setting was probably a
 * typo — ten valid keys reported as mistakes. The same reasoning already moved
 * `visionModel`/`browserProfile` into COMMON_CONFIG_KEYS above; this handles
 * the general case instead of one key at a time.
 */
export function classifyConfigKeys(surface: ConfigSurface, keys: Iterable<string>): ConfigKeyVerdict[] {
  const known = knownConfigKeys(surface);
  const verdicts: ConfigKeyVerdict[] = [];
  for (const key of keys) {
    if (known.has(key)) continue;
    const surfaces = surfacesForConfigKey(key);
    verdicts.push(surfaces.length > 0 ? { key, kind: "other-surface", surfaces } : { key, kind: "unknown" });
  }
  return verdicts;
}
