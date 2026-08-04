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
