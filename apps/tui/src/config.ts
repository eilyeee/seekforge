import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookConfig, McpServerConfig, ModelPricing } from "@seekforge/core";
import type { HookStage, PermissionRule } from "@seekforge/shared";
import { mergeConfigLayers, readJsonConfigLayer } from "@seekforge/shared/config-layers";

/**
 * Local copy of the CLI's config type/loader. Apps must not depend on apps,
 * so the precedence logic (env > project > global) is replicated here.
 */
export type TuiConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** Fine-grained allow/deny permission rules (project rules first). */
  permissionRules?: PermissionRule[];
  /** MCP servers (Claude Code-compatible). */
  mcpServers?: Record<string, McpServerConfig>;
  /** User-defined shell hooks fired around tool calls. */
  hooks?: HookConfig;
  /** TUI accent color (any Ink color name); SEEKFORGE_TUI_ACCENT overrides. */
  accent?: string;
  /** Terminal bell on permission prompts / run completion (default true). */
  bell?: boolean;
  /** OS notifications (macOS osascript / linux notify-send; default true). */
  notify?: boolean;
  /** Start the composer in vim mode (/vim toggles at runtime). */
  vim?: boolean;
  /** OS-level command sandbox: "workspace-write" or "restricted" (off when unset). */
  sandbox?: "off" | "workspace-write" | "restricted";
  /** Shell command producing one custom status-bar line (JSON payload on stdin). */
  statusLine?: string;
  /** Warn at 80% and 100% of this cumulative cost (USD) per TUI session. */
  costBudgetUsd?: number;
  /**
   * User-supplied per-model price table (model id → { inputCacheMissPer1M,
   * inputCacheHitPer1M, outputPer1M } in USD per 1M tokens). Enables cost/budget
   * tracking on providers with no built-in price table (Ark, OpenAI, …); without
   * it cost stays 0 there. Edit the file directly; not settable via `config set`.
   */
  modelPricing?: Record<string, ModelPricing>;
  /** DeepSeek V4 thinking mode (default: API default). /think toggles. */
  thinking?: boolean;
  /** V4 reasoning effort: "high" or "max". */
  reasoningEffort?: "high" | "max";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** Capture the mouse for wheel scrolling (default false: text stays selectable). */
  mouse?: boolean;
  /** UI language ("en" | "zh-CN"); SEEKFORGE_LANG/LANG also detected. */
  locale?: "en" | "zh-CN";
  /** Vision model for the image_analyze tool (OpenAI-compatible endpoint). */
  visionModel?: { model: string; baseUrl?: string; apiKey?: string };
  /** Cache identical non-streaming LLM calls on disk (evals/subagents). */
  llmCache?: boolean;
  /** Flat documented key: /plan runs think on this model (e.g. deepseek-v4-pro). Takes precedence over routing.planModel. */
  planModel?: string;
  /** Model routing (back-compat): /plan runs think on this model (e.g. deepseek-v4-pro). */
  routing?: { planModel?: string };
  /** Default-off: hand the run to planModel once it loops on a failure. */
  escalateOnFailure?: boolean;
  /** Auto-approve extracted memories at/above this confidence (0-1); unset = no auto-approve. */
  memoryAutoApproveConfidence?: number;
  /** Self-lint gate (parallel to verifyCommand): lint command run before finishing after edits. */
  lintCommand?: string;
  /** Default true (when lintCommand set): run the lint command automatically on completion. */
  autoLint?: boolean;
  /** Edit format: "patch" (default) or "whole" (prefer write_file — for weak/local models). */
  editFormat?: "patch" | "whole";
};

function readJson(path: string): TuiConfig {
  // NOTE: no requireObject guard — the TUI historically passes non-object JSON
  // through as-parsed (only the CLI collapses those layers to {}).
  return readJsonConfigLayer<TuiConfig>(path);
}

/** Every recognized top-level config key — the source of truth for typo detection. */
export const KNOWN_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "permissionRules",
  "mcpServers",
  "hooks",
  "accent",
  "bell",
  "notify",
  "vim",
  "sandbox",
  "statusLine",
  "costBudgetUsd",
  "modelPricing",
  "thinking",
  "reasoningEffort",
  "compaction",
  "mouse",
  "locale",
  "visionModel",
  "llmCache",
  "planModel",
  "routing",
  "escalateOnFailure",
  "memoryAutoApproveConfidence",
  "lintCommand",
  "autoLint",
  "editFormat",
]);

/**
 * Unrecognized top-level keys across the config layers — a typo like "modle" is
 * otherwise silently ignored. Returns a sorted, deduped list; empty when
 * everything is recognized. Surfaced by the TUI /doctor.
 */
export function unknownConfigKeys(projectPath: string): string[] {
  const unknown = new Set<string>();
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
  ]) {
    const cfg = readJson(path) as unknown;
    if (!isRecord(cfg)) continue;
    for (const key of Object.keys(cfg)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) unknown.add(key);
    }
  }
  return [...unknown].sort();
}

/**
 * Config-layer paths that EXIST on disk but fail JSON.parse — `readJson`
 * silently drops these to `{}`, so a single typo in config.json otherwise
 * discards every setting AND /doctor reports clean. Returns the unparseable
 * file paths (empty when all layers parse or are absent). Surfaced by /doctor.
 */
export function configParseErrors(projectPath: string): string[] {
  const broken: string[] = [];
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
  ]) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue; // absent/unreadable — not a parse error
    }
    try {
      JSON.parse(raw);
    } catch {
      broken.push(path);
    }
  }
  return broken;
}

/**
 * Historical stage iteration order (sessionEnd third). Passed to the shared
 * merge so the key insertion order of the merged hooks object — observable
 * through JSON serialization — stays byte-identical to the old local loop.
 */
const HOOK_STAGE_ORDER: readonly HookStage[] = [
  "preToolUse",
  "postToolUse",
  "sessionEnd",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
];

/** Precedence: env > project .seekforge/config.json > ~/.seekforge/config.json */
export function loadConfig(projectPath: string): TuiConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  // Shared merge algebra (see @seekforge/shared/config-layers): scalars spread
  // project-over-global; mcpServers merge per server name (project wins);
  // permissionRules concatenate project-then-global (first match wins); hooks
  // concatenate per stage global-then-project (every hook runs); then the
  // provider-aware env API key + SEEKFORGE_RUNTIME_BIN overrides land on top.
  return mergeConfigLayers<TuiConfig>([global, project], { hookStages: HOOK_STAGE_ORDER });
}
