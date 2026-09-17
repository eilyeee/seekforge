import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  HookConfig,
  LspServerConfig,
  McpServerConfig,
  MemoryMaintenanceConfig,
  ModelPricing,
} from "@seekforge/core";
import type { HookStage, PermissionRule, ReasoningEffort } from "@seekforge/shared";
import {
  type ConfigLayer,
  type ConfigLayerOrigin,
  type ConfigMergeReport,
  describeConfigMergeReport,
  mergeConfigLayers,
  mergeConfigLayersWithReport,
  readProjectMcpJsonLayer,
  repositoryConfigLayer,
  userConfigLayer,
} from "@seekforge/shared/config-layers";
import { classifyConfigKeys, type ConfigKeyVerdict, knownConfigKeys } from "@seekforge/shared/config-manifest";
import { FileTooLargeError, MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";

/**
 * Local copy of the CLI's config type/loader. Apps must not depend on apps,
 * so the precedence logic (env > project > global) is replicated here.
 */
export type TuiConfig = {
  apiKey?: string;
  /**
   * Shell command whose stdout is the API key (user-owned layers only). The
   * config merge runs it and fills `apiKey`; the provider refreshes the key.
   */
  apiKeyHelper?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** Fine-grained rules; repository config may contribute deny and ask rules only. */
  permissionRules?: PermissionRule[];
  /** MCP servers (Claude Code-compatible). */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Share (0-100, default 10) of the context budget MCP tool definitions may
   * take before they are deferred behind the tool_search tool.
   */
  mcpToolSearchThreshold?: number;
  /** User-owned shell hooks fired around tool calls. */
  hooks?: HookConfig;
  /** TUI accent color (any Ink color name); SEEKFORGE_TUI_ACCENT overrides. */
  accent?: string;
  /** Terminal bell on permission prompts / run completion (default true). */
  bell?: boolean;
  /** OS notifications (macOS osascript / linux notify-send; default true). */
  notify?: boolean;
  /** Start the composer in vim mode (/vim toggles at runtime). */
  vim?: boolean;
  /** OS-level command sandbox (off when unset). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  /** Domain allowlist for sandboxed commands (user-owned; core validates it). */
  sandboxNetwork?: { allowedDomains: string[]; deniedDomains?: string[] };
  /** Directories outside the project the file tools may also use (user-owned). */
  additionalDirectories?: string[];
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
  /**
   * Whether images travel inline to the model (a screenshot attached to the tool
   * result that produced it). Unset follows the provider preset. Edit the file
   * directly; not settable via `config set`.
   */
  inlineImages?: boolean;
  /** DeepSeek V4 thinking mode (default: API default). /think toggles. */
  thinking?: boolean;
  /** Reasoning effort (low | medium | high | max); each provider sends what its endpoint accepts. /think sets it. */
  reasoningEffort?: ReasoningEffort;
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** Fraction (0, 1] of the context budget at which compaction starts (default 0.9). User-owned. */
  autoCompactThreshold?: number;
  /** Context-window overrides in tokens, keyed by exact model id. User-owned. */
  modelContextWindows?: Record<string, number>;
  /** Capture the mouse for wheel scrolling (default false: text stays selectable). */
  mouse?: boolean;
  /** UI language ("en" | "zh-CN"); SEEKFORGE_LANG/LANG also detected. */
  locale?: "en" | "zh-CN";
  /** Vision model for the image_analyze tool (OpenAI-compatible endpoint). */
  visionModel?: { model: string; baseUrl?: string; apiKey?: string };
  /**
   * web_search's backends, most authoritative first: a Brave Search API key,
   * then a SearXNG base URL, then the DuckDuckGo scrape that is always there.
   * User config only — see PROJECT_PREFERENCE_KEYS.
   */
  webSearch?: { searxngUrl?: string; braveApiKey?: string };
  /**
   * Name of a persistent browser session profile. When set, the browser tools
   * start from `~/.seekforge/browser-profiles/<name>.json` and write it back on
   * teardown, so a site logged into once stays logged in. Unset = every run
   * starts logged out, which is the default because the file IS the login.
   */
  browserProfile?: string;
  /** Language servers for the lsp_* tools (user config only; see docs/lsp.md). */
  lspServers?: Record<string, LspServerConfig>;
  /** Also load Claude Code skills from `~/.claude/skills` (user config only). */
  claudeUserSkills?: boolean;
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
  /** Opt-in deterministic project-memory maintenance; trusted layers only. */
  memoryMaintenance?: MemoryMaintenanceConfig;
  /** Self-lint gate (parallel to verifyCommand): lint command run before finishing after edits. */
  lintCommand?: string;
  /** Default true (when lintCommand set): run the lint command automatically on completion. */
  autoLint?: boolean;
  /** Edit format: "patch" (default) or "whole" (prefer write_file — for weak/local models). */
  editFormat?: "patch" | "whole";
  /** Claude Code instruction files to load: "project" (default), "all" (+ ~/.claude/CLAUDE.md), "off". */
  claudeCompat?: "off" | "project" | "all";
  /** Named overlays selected with --profile / SEEKFORGE_PROFILE; stripped from the loaded config. */
  profiles?: Record<string, Partial<TuiConfig>>;
};

function readJson(path: string): TuiConfig {
  try {
    const parsed: unknown = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES));
    return isPlainObject(parsed) ? (parsed as TuiConfig) : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every recognized top-level config key — the source of truth for typo detection. */
export const KNOWN_CONFIG_KEYS = knownConfigKeys("tui");

/**
 * Top-level keys across the config layers that the TUI does not honor, each
 * classified as a typo or as a key another frontend reads. Sorted and deduped;
 * empty when everything is recognized. Surfaced by the TUI /doctor.
 *
 * One config.json serves the CLI, the TUI and the server, so a key this
 * frontend ignores is not automatically a mistake — see classifyConfigKeys.
 */
export function unknownConfigKeys(projectPath: string): ConfigKeyVerdict[] {
  const unknown = new Set<string>();
  for (const path of [join(homedir(), ".seekforge", "config.json"), join(projectPath, ".seekforge", "config.json")]) {
    const cfg = readJson(path) as unknown;
    if (!isPlainObject(cfg)) continue;
    for (const key of Object.keys(cfg)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) unknown.add(key);
    }
  }
  return classifyConfigKeys("tui", [...unknown].sort());
}

/**
 * Config-layer paths that exist but fail JSON parsing or are not JSON objects.
 * `readJson` silently drops these to `{}`, so without this diagnostic an invalid
 * layer discards every setting while /doctor reports clean.
 */
export function configParseErrors(projectPath: string): string[] {
  const broken: string[] = [];
  for (const path of [join(homedir(), ".seekforge", "config.json"), join(projectPath, ".seekforge", "config.json")]) {
    let raw: string;
    try {
      raw = readTextFileBounded(path, MAX_CONFIG_FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      broken.push(path);
      continue;
    }
    try {
      if (!isPlainObject(JSON.parse(raw))) broken.push(path);
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

/** Precedence: env > safe project preferences > ~/.seekforge/config.json */
export function mergeTuiConfig(global: TuiConfig, project: TuiConfig): TuiConfig {
  // Repository config is downgraded before the shared merge: it cannot route
  // credentials, execute startup code, authorize tools, or grant MCP trust —
  // and, because the layer carries its origin, it cannot repoint an MCP server
  // the user defined either.
  return mergeConfigLayers<TuiConfig>([userConfigLayer(global), repositoryConfigLayer(project)], {
    hookStages: HOOK_STAGE_ORDER,
  });
}

/** Launch-time layer selection (`--settings`, `--profile`). */
export type ConfigLoadOptions = {
  /** An explicit JSON settings file: user-owned, above every file layer. */
  settingsPath?: string;
  /** Named overlay from `profiles` (falls back to SEEKFORGE_PROFILE). */
  profile?: string;
  /** Test seam for the user home. */
  home?: string;
};

/** A config failure the launcher prints as `message` plus `hint`. */
export class ConfigLoadError extends Error {
  constructor(
    message: string,
    readonly hint: string,
  ) {
    super(message);
    this.name = "ConfigLoadError";
  }
}

export function userConfigFile(home: string = homedir()): string {
  return join(home, ".seekforge", "config.json");
}

export function projectConfigFile(projectPath: string): string {
  return join(projectPath, ".seekforge", "config.json");
}

function readSettingsFile(settingsPath: string): TuiConfig {
  const absPath = resolve(settingsPath);
  let raw: string;
  try {
    raw = readTextFileBounded(absPath, MAX_CONFIG_FILE_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw new ConfigLoadError(
        `settings file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${absPath}`,
        "use a smaller file",
      );
    }
    throw new ConfigLoadError(`settings file not readable: ${absPath}`, "check the --settings path");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigLoadError(
      `invalid JSON in settings file ${absPath}: ${error instanceof Error ? error.message : String(error)}`,
      "the --settings file must contain one JSON object",
    );
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigLoadError(`invalid settings file ${absPath}: expected a JSON object`, 'e.g. { "model": "…" }');
  }
  return parsed as TuiConfig;
}

function profileAt(config: TuiConfig, name: string): TuiConfig | undefined {
  const profiles = config.profiles as unknown;
  if (!isPlainObject(profiles)) return undefined;
  const candidate = profiles[name];
  return isPlainObject(candidate) ? (candidate as TuiConfig) : undefined;
}

/**
 * The selected profile as origin-tagged layers (user profile first, project
 * profile above it), matching the CLI's resolution: a profile read out of the
 * repository's config is repository input and is downgraded like the file.
 */
function profileLayers(name: string, global: TuiConfig, project: TuiConfig): ConfigLayer<TuiConfig>[] {
  const layers: ConfigLayer<TuiConfig>[] = [];
  const fromGlobal = profileAt(global, name);
  const fromProject = profileAt(project, name);
  if (fromGlobal) layers.push(userConfigLayer(fromGlobal));
  if (fromProject) layers.push(repositoryConfigLayer(fromProject));
  if (layers.length === 0) {
    const names = new Set<string>();
    for (const config of [global, project]) {
      if (isPlainObject(config.profiles)) {
        for (const [key, value] of Object.entries(config.profiles)) if (isPlainObject(value)) names.add(key);
      }
    }
    throw new ConfigLoadError(
      `unknown profile "${name}"`,
      `available profiles: ${names.size > 0 ? [...names].sort().join(", ") : "(none defined)"}`,
    );
  }
  return layers;
}

/**
 * Loads the effective config plus where each MCP server name came from.
 * Precedence (low → high): ~/.seekforge/config.json, the project's `.mcp.json`
 * (server definitions only), project .seekforge/config.json, the selected
 * profile, the --settings file, env. Throws ConfigLoadError for an unreadable
 * --settings file or unknown profile.
 */
export function resolveTuiConfig(
  projectPath: string,
  opts: ConfigLoadOptions = {},
): { config: TuiConfig; mcpOrigins: Record<string, ConfigLayerOrigin>; report: ConfigMergeReport } {
  const global = readJson(userConfigFile(opts.home));
  const project = readJson(projectConfigFile(projectPath));
  const profileName = opts.profile ?? (process.env["SEEKFORGE_PROFILE"] || undefined);
  const layers: ConfigLayer<TuiConfig>[] = [
    userConfigLayer(global),
    // Claude Code's project server file sits below SeekForge's own project config.
    readProjectMcpJsonLayer<TuiConfig>(projectPath),
    repositoryConfigLayer(project),
    ...(profileName ? profileLayers(profileName, global, project) : []),
    ...(opts.settingsPath ? [userConfigLayer(readSettingsFile(opts.settingsPath))] : []),
  ];
  const { config, report } = mergeConfigLayersWithReport<TuiConfig>(layers, { hookStages: HOOK_STAGE_ORDER });
  // A selection mechanism, not effective config.
  delete config.profiles;
  return { config, mcpOrigins: report.mcpServerOrigins, report };
}

/**
 * What the merge narrowed (a repository server shadowed by the user's, trust
 * fields refused), one line each, without the apiKeyHelper failure — the
 * launcher reports that one on its own, in place of the key wizard.
 */
export function configMergeWarnings(report: ConfigMergeReport): string[] {
  const { apiKeyHelperError: _reportedSeparately, ...rest } = report;
  return describeConfigMergeReport(rest).map((line) => line.trimEnd());
}

export function loadConfig(projectPath: string, opts: ConfigLoadOptions = {}): TuiConfig {
  return resolveTuiConfig(projectPath, opts).config;
}
