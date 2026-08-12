import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookConfig, McpServerConfig, MemoryMaintenanceConfig, ModelPricing } from "@seekforge/core";
import type { PermissionRule } from "@seekforge/shared";
import {
  type ConfigLayer,
  type ConfigLayerOrigin,
  describeConfigMergeReport,
  mergeConfigLayersWithReport,
  repositoryConfigLayer,
  userConfigLayer,
} from "@seekforge/shared/config-layers";
import { classifyConfigKeys, type ConfigKeyVerdict, knownConfigKeys } from "@seekforge/shared/config-manifest";
import { FileTooLargeError, MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";

export type CliConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /**
   * Fine-grained allow/deny permission rules. First match of each action
   * category wins (deny scanned before allow); repository layers may only add
   * deny rules. Edit trusted rules in user config or --settings.
   */
  permissionRules?: PermissionRule[];
  /** MCP servers (Claude Code-compatible). Edit the file directly; not settable via `config set`. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * User-defined shell hooks fired around tool calls. preToolUse hooks can
   * block a tool (non-zero exit); postToolUse/sessionEnd are advisory. Edit
   * the file directly; not settable via `config set`.
   */
  hooks?: HookConfig;
  /** OS-level command sandbox (off when unset). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). /think toggles in the REPL. */
  thinking?: boolean;
  /** V4 reasoning effort: "high" or "max". */
  reasoningEffort?: "high" | "max";
  /** UI language for CLI chrome (errors, prompts, command output). */
  locale?: "en" | "zh-CN";
  /**
   * Vision endpoint for the `image_analyze` builtin (OpenAI-compatible). The
   * main provider usually cannot see images, so this is typically a separate
   * model and key. Unset leaves the tool reporting "vision_unconfigured".
   * User-owned: a project config cannot point it anywhere.
   */
  visionModel?: { model: string; baseUrl?: string; apiKey?: string };
  /**
   * web_search's backends, most authoritative first: a Brave Search API key,
   * then a SearXNG base URL, then the DuckDuckGo scrape that is always there.
   * User config only — see PROJECT_PREFERENCE_KEYS.
   */
  webSearch?: { searxngUrl?: string; braveApiKey?: string };
  /**
   * Name of a persistent browser session profile. When set, the browser tools
   * start from `~/.seekforge/browser-profiles/<name>.json` and write it back
   * when the run finishes, so a site logged into once stays logged in. Unset =
   * every run starts logged out. See docs/browser.md.
   */
  browserProfile?: string;
  /**
   * Default per-run cost budget in USD: a `run`/`ask` stops once cumulative
   * cost reaches it (graceful abort, trace kept). Overridden by the CLI
   * `--max-cost` flag. Off when unset/non-positive. Edit the file directly;
   * not settable via `config set`.
   */
  maxCostUsd?: number;
  /**
   * Default per-run wall-clock budget in seconds: a `run`/`ask` stops once the
   * deadline passes, whether or not the run is still producing events (that is
   * the case it exists for). Overridden by the CLI `--max-duration` flag. Off
   * when unset/non-positive. Edit the file directly; not settable via
   * `config set`.
   */
  maxDurationSeconds?: number;
  /**
   * User-supplied per-model price table (model id → { inputCacheMissPer1M,
   * inputCacheHitPer1M, outputPer1M } in USD per 1M tokens). Enables cost and
   * `maxCostUsd` budget tracking on providers with no built-in price table
   * (Ark, OpenAI, …); without it, cost stays 0 there. A priced model always
   * gets a real cost even on those providers. Edit the file directly; not
   * settable via `config set`.
   */
  modelPricing?: Record<string, ModelPricing>;
  /**
   * Whether images travel inline to the model — a screenshot attached to the
   * tool result that produced it, rather than a path the model must open with
   * `image_analyze`. Unset follows the provider preset, which answers for the
   * catalog it ships; set it when your model disagrees with that default (a
   * multimodal doubao on Ark, a pulled llava on Ollama, a text-only model on an
   * endpoint whose others have eyes). Edit the file directly; not settable via
   * `config set`.
   */
  inlineImages?: boolean;
  /**
   * Stronger model for plan runs (`/plan`) and failure escalation, resolved on
   * the same key/endpoint (e.g. "deepseek-v4-pro" while edits run on flash).
   * Edit the file directly; not settable via `config set`.
   */
  planModel?: string;
  /**
   * Default-off: once the model loops on an identical failed tool call, hand the
   * rest of the run to `planModel`. Edit the file directly; not settable via
   * `config set`. (autoReview/planFirst were removed — eval-negative.)
   */
  escalateOnFailure?: boolean;
  /**
   * Self-verification: a shell command (e.g. "pnpm test") the agent is nudged to
   * run before finishing whenever it has edited files but not run it since. By
   * default the loop runs it automatically on the finish turn and feeds the
   * real result back (a pass is accepted, a failure continues with the output);
   * see autoVerify. Off when unset/empty. Edit the file directly; not settable
   * via `config set`.
   */
  verifyCommand?: string;
  /**
   * Default true (when verifyCommand is set): run the verify command
   * automatically on completion. Set false to only nudge the model to run it
   * (e.g. to force it through the permission flow). Edit the file directly.
   */
  autoVerify?: boolean;
  /**
   * Self-lint gate (parallel to verifyCommand): a shell command (e.g. "pnpm
   * lint") the agent runs before finishing whenever it has edited files but not
   * run it since. By default the loop runs it automatically on the finish turn
   * and feeds failures back (see autoLint). Off when unset/empty. Edit the file
   * directly; not settable via `config set`.
   */
  lintCommand?: string;
  /**
   * Default true (when lintCommand is set): run the lint command automatically
   * on completion. Set false to only nudge the model to run it. Edit the file
   * directly.
   */
  autoLint?: boolean;
  /**
   * Model-adaptive edit format: "patch" (default) guides apply_patch
   * search/replace edits; "whole" guides preferring write_file (whole-file
   * rewrites) for weak/local models that mangle search/replace. Edit the file
   * directly; not settable via `config set`.
   */
  editFormat?: "patch" | "whole";
  /**
   * Default-off: when the agent finishes after editing files, nudge it once to
   * self-review its own diff before completing. Edit the file directly; not
   * settable via `config set`.
   */
  finalizeReview?: boolean;
  /**
   * Default-off premature-finish guard: nudge once if an edit-mode run declares
   * done having changed nothing and barely used any tools (a bail-out). Edit the
   * file directly; not settable via `config set`.
   */
  guardNoProgress?: boolean;
  /**
   * Default-off: confidence threshold (0..1) above which auto-extracted memory
   * facts are written DIRECTLY to project.md as approved, instead of queued as
   * pending candidates. Unset = every extracted fact stays pending for review.
   * Edit the file directly; not settable via `config set`.
   */
  memoryAutoApproveConfidence?: number;
  /** Opt-in deterministic project-memory maintenance; trusted layers only. */
  memoryMaintenance?: MemoryMaintenanceConfig;
  /**
   * Named config overlays selectable via `--profile <name>` (or the
   * SEEKFORGE_PROFILE env var). Each profile is a partial CliConfig whose fields
   * override the merged base (see loadConfig for exact precedence). The
   * `profiles` map itself is stripped from the value returned by loadConfig.
   * Edit the file directly; not settable via `config set`.
   */
  profiles?: Record<string, Partial<CliConfig>>;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * loadConfig runs several times in one process (the command, its verify pass,
 * doctor's probes), so a per-call warning would repeat the same line three or
 * four times. Warnings go to stderr, never stdout: a machine output format owns
 * stdout and must stay parseable.
 */
const warnedConfigLines = new Set<string>();
function warnOnce(line: string): void {
  if (warnedConfigLines.has(line)) return;
  warnedConfigLines.add(line);
  process.stderr.write(line);
}

function readJson(path: string): CliConfig {
  try {
    const parsed: unknown = JSON.parse(readTextFileBounded(path, MAX_CONFIG_FILE_BYTES));
    return isPlainObject(parsed) ? (parsed as CliConfig) : {};
  } catch {
    return {};
  }
}

/**
 * Config-layer paths that exist but fail JSON parsing or are not JSON objects.
 * `readJson` silently drops these to `{}`, so without this diagnostic an invalid
 * layer discards every setting while `seekforge doctor` reports clean.
 */
export function configParseErrors(projectPath: string): string[] {
  const broken: string[] = [];
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.local.json"),
  ]) {
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

/** Object-valued profile names only; malformed entries are inert. */
function validProfileNames(config: CliConfig): string[] {
  const profiles = config.profiles as unknown;
  if (!isPlainObject(profiles)) return [];
  return Object.entries(profiles)
    .filter((entry) => isPlainObject(entry[1]))
    .map((entry) => entry[0]);
}

/** Profile names defined across the global/project/local config layers, sorted. */
export function availableProfiles(projectPath: string): string[] {
  const names = new Set<string>();
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.local.json"),
  ]) {
    for (const name of validProfileNames(readJson(path))) names.add(name);
  }
  return [...names].sort();
}

/** Every recognized top-level config key — the source of truth for typo detection. */
export const KNOWN_CONFIG_KEYS = knownConfigKeys("cli");

/**
 * Top-level keys across the config layers that this frontend does not honor,
 * each classified as a typo or as a key another frontend reads. Also covers
 * typos inside each named `profiles` entry (which are themselves
 * Partial<CliConfig>). Sorted and deduped; empty when everything is recognized.
 * Surfaced by `seekforge doctor`.
 *
 * The classification matters because one config.json serves the CLI, the TUI
 * and the server: `models` is the Desktop's, `accent` is the TUI's, and
 * reporting either as a probable typo is the diagnostic being wrong.
 */
export function unknownConfigKeys(projectPath: string): ConfigKeyVerdict[] {
  const unknown = new Set<string>();
  const collect = (obj: Record<string, unknown>): void => {
    for (const key of Object.keys(obj)) {
      if (!KNOWN_CONFIG_KEYS.has(key)) unknown.add(key);
    }
  };
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.local.json"),
  ]) {
    const cfg = readJson(path) as Record<string, unknown>;
    collect(cfg);
    if (isRecord(cfg["profiles"])) {
      for (const profile of Object.values(cfg["profiles"])) {
        if (isRecord(profile)) collect(profile);
      }
    }
  }
  return classifyConfigKeys("cli", [...unknown].sort());
}

/**
 * Read and parse a settings file, throwing a descriptive error on missing or
 * malformed JSON. The error carries a `hint` property so the CLI layer can
 * render it via fail(message, { hint }).
 */
function readSettingsFile(settingsPath: string): CliConfig {
  const absPath = resolve(settingsPath);
  let raw: string;
  try {
    raw = readTextFileBounded(absPath, MAX_CONFIG_FILE_BYTES);
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      throw Object.assign(new Error(`settings file exceeds ${MAX_CONFIG_FILE_BYTES} bytes: ${absPath}`), {
        hint: "reduce the settings file size and try again",
      });
    }
    throw Object.assign(new Error(`settings file not found: ${absPath}`), {
      hint: "check the path and try again",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`invalid JSON in settings file ${absPath}: ${msg}`), {
      hint: "ensure the file contains valid JSON",
    });
  }
  if (!isPlainObject(parsed)) {
    throw Object.assign(new Error(`invalid settings file ${absPath}: expected a JSON object`), {
      hint: 'the top-level value must be an object, e.g. { "mcpServers": {} }',
    });
  }
  return parsed as CliConfig;
}

/**
 * Resolve a named profile across the file layers, returning its layers ready to
 * slot into the base merge — global-profile first, then project, then local, so
 * a name clash resolves project over global and local over both, matching the
 * precedence of the plain config layers.
 *
 * The profile is returned as SEPARATE tagged layers rather than one pre-merged
 * overlay. Flattening it first would erase which file each entry came from, and
 * for `mcpServers` that distinction is the trust boundary. Merging the whole
 * stack in one pass is equivalent for every other field: scalars spread in the
 * same order, `permissionRules` unshift in the same order, and `hooks`
 * concatenate per stage in the same order.
 *
 * Returns `undefined` when `name` is unset. Throws a descriptive (hint-carrying)
 * error when `name` is given but no layer defines a profile of that name.
 */
function resolveProfile(
  name: string | undefined,
  layers: { global: CliConfig; project: CliConfig; local: CliConfig },
): ConfigLayer<Partial<CliConfig>>[] | undefined {
  if (!name) return undefined;
  const { global, project, local } = layers;
  const profileAt = (config: CliConfig): Partial<CliConfig> | undefined => {
    const profiles = config.profiles as unknown;
    if (!isPlainObject(profiles)) return undefined;
    const candidate = (profiles as Record<string, unknown>)[name];
    return isPlainObject(candidate) ? (candidate as Partial<CliConfig>) : undefined;
  };
  // Order low→high precedence; later entries override earlier on scalars.
  const globalProfile = profileAt(global);
  const projectProfile = profileAt(project);
  const localProfile = profileAt(local);
  const present: ConfigLayer<Partial<CliConfig>>[] = [];
  if (globalProfile !== undefined) present.push(userConfigLayer(globalProfile));
  if (projectProfile !== undefined) present.push(repositoryConfigLayer(projectProfile));
  if (localProfile !== undefined) present.push(repositoryConfigLayer(localProfile));
  if (present.length === 0) {
    const names = Array.from(new Set([global, project, local].flatMap(validProfileNames))).sort();
    const list = names.length > 0 ? names.join(", ") : "(none defined)";
    throw Object.assign(new Error(`unknown profile "${name}"`), {
      hint: `available profiles: ${list}`,
    });
  }
  return present;
}

/**
 * Precedence: env > CLI flags > --settings file > selected --profile overlay
 *   > .seekforge/config.local.json > project .seekforge/config.json
 *   > ~/.seekforge/config.json
 *
 * config.local.json slots just above shared project config, but both are
 * repository-owned and sanitized before merging. The --settings layer sits
 * above it. A selected profile (--profile <name> or SEEKFORGE_PROFILE) slots
 * just below --settings and above config.local — its fields override the merged
 * base. The profile is looked up across the file layers (project winning over
 * global on a name clash, local over both), same as the other merges. For
 * deep-merge fields (mcpServers, permissionRules, hooks), each layer — including
 * the profile — is merged into the existing logic rather than replacing
 * wholesale. The `profiles` map itself is stripped from the returned config.
 *
 * `mcpServers` is the one deep-merge field where "the higher layer wins" is the
 * wrong rule, because the higher layers here are the repository-owned ones. The
 * shared merge enforces that from the layer origins: a repository layer may add
 * server names but never repoint one the user owns, and may only make its own
 * entries stricter. See packages/shared/src/config-layers.ts.
 */
export function loadConfig(projectPath: string, settingsPath?: string, profile?: string): CliConfig {
  return resolveConfig(projectPath, settingsPath, profile).config;
}

/**
 * loadConfig plus the origin of each surviving MCP server name. Management
 * commands need it: `mcp list` spawns what it lists, and "who wrote this entry"
 * is the difference between running the user's own tool and running whatever a
 * cloned repository put in `.seekforge/config.json`.
 */
export function resolveConfig(
  projectPath: string,
  settingsPath?: string,
  profile?: string,
): { config: CliConfig; mcpOrigins: Record<string, ConfigLayerOrigin> } {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  const local = readJson(join(projectPath, ".seekforge", "config.local.json"));
  const settings = settingsPath ? readSettingsFile(settingsPath) : {};

  const profileName = profile ?? process.env["SEEKFORGE_PROFILE"] ?? undefined;
  const profileLayers = resolveProfile(profileName, { global, project, local }) ?? [];

  // Repository layers retain safe preferences, deny rules, and untrusted MCP
  // definitions — repositoryConfigLayer downgrades and tags in one step.
  // User-owned global/settings layers retain full authority; env
  // credentials/runtime overrides land on top.
  const { config: result, report } = mergeConfigLayersWithReport<CliConfig>([
    userConfigLayer(global),
    repositoryConfigLayer(project),
    repositoryConfigLayer(local),
    ...profileLayers,
    userConfigLayer(settings),
  ]);
  // A narrowing the user cannot see is its own defect: say what was dropped.
  for (const line of describeConfigMergeReport(report)) warnOnce(line);
  // `profiles` is a selection mechanism, not effective config — never leak it.
  delete result.profiles;
  return { config: result, mcpOrigins: report.mcpServerOrigins };
}
