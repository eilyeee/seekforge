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
] as const;

export const SURFACE_CONFIG_KEYS = {
  cli: ["maxCostUsd", "verifyCommand", "autoVerify", "finalizeReview", "guardNoProgress", "profiles"],
  tui: [
    "accent",
    "bell",
    "notify",
    "vim",
    "statusLine",
    "costBudgetUsd",
    "mouse",
    "visionModel",
    "llmCache",
    "routing",
  ],
  server: ["models"],
} as const;

export type ConfigSurface = keyof typeof SURFACE_CONFIG_KEYS;

export function knownConfigKeys(surface: ConfigSurface): ReadonlySet<string> {
  return new Set([...COMMON_CONFIG_KEYS, ...SURFACE_CONFIG_KEYS[surface]]);
}
