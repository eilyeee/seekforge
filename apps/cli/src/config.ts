import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookConfig, McpServerConfig } from "@seekforge/core";
import type { PermissionRule } from "@seekforge/shared";

export type CliConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /**
   * Fine-grained allow/deny permission rules. First match of each action
   * category wins (deny scanned before allow); project rules are merged
   * before global ones. Edit the file directly; not settable via `config set`.
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
  /** OS-level command sandbox: "workspace-write" or "restricted" (off when unset). */
  sandbox?: "off" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). /think toggles in the REPL. */
  thinking?: boolean;
  /** V4 reasoning effort: "high" or "max". */
  reasoningEffort?: "high" | "max";
  /** UI language for CLI chrome (errors, prompts, command output). */
  locale?: "en" | "zh-CN";
  /**
   * Default per-run cost budget in USD: a `run`/`ask` stops once cumulative
   * cost reaches it (graceful abort, trace kept). Overridden by the CLI
   * `--max-cost` flag. Off when unset/non-positive. Edit the file directly;
   * not settable via `config set`.
   */
  maxCostUsd?: number;
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
   * Default-off: confidence threshold (0..1) above which auto-extracted memory
   * facts are written DIRECTLY to project.md as approved, instead of queued as
   * pending candidates. Unset = every extracted fact stays pending for review.
   * Edit the file directly; not settable via `config set`.
   */
  memoryAutoApproveConfidence?: number;
  /**
   * Named config overlays selectable via `--profile <name>` (or the
   * SEEKFORGE_PROFILE env var). Each profile is a partial CliConfig whose fields
   * override the merged base (see loadConfig for exact precedence). The
   * `profiles` map itself is stripped from the value returned by loadConfig.
   * Edit the file directly; not settable via `config set`.
   */
  profiles?: Record<string, Partial<CliConfig>>;
};

function readJson(path: string): CliConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Profile names defined across the global/project/local config layers, sorted. */
export function availableProfiles(projectPath: string): string[] {
  const names = new Set<string>();
  for (const path of [
    join(homedir(), ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.json"),
    join(projectPath, ".seekforge", "config.local.json"),
  ]) {
    for (const name of Object.keys(readJson(path).profiles ?? {})) names.add(name);
  }
  return [...names].sort();
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
    raw = readFileSync(absPath, "utf8");
  } catch {
    throw Object.assign(new Error(`settings file not found: ${absPath}`), {
      hint: "check the path and try again",
    });
  }
  try {
    return JSON.parse(raw) as CliConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`invalid JSON in settings file ${absPath}: ${msg}`), {
      hint: "ensure the file contains valid JSON",
    });
  }
}

/**
 * Resolve a named profile across the file layers and return it as a single
 * Partial<CliConfig> overlay. On a name clash the project profile wins over the
 * global one, and the local profile wins over both — matching the precedence of
 * the plain config layers. Deep-merge fields (mcpServers/permissionRules/hooks)
 * are combined across layers the same way the base config layers are.
 *
 * Returns `undefined` when `name` is unset. Throws a descriptive (hint-carrying)
 * error when `name` is given but no layer defines a profile of that name.
 */
function resolveProfile(
  name: string | undefined,
  layers: { global: CliConfig; project: CliConfig; local: CliConfig },
): Partial<CliConfig> | undefined {
  if (!name) return undefined;
  const { global, project, local } = layers;
  // Order low→high precedence; later entries override earlier on scalars.
  const sources = [global.profiles?.[name], project.profiles?.[name], local.profiles?.[name]];
  const present = sources.filter((p): p is Partial<CliConfig> => p !== undefined);
  if (present.length === 0) {
    const names = Array.from(
      new Set([
        ...Object.keys(global.profiles ?? {}),
        ...Object.keys(project.profiles ?? {}),
        ...Object.keys(local.profiles ?? {}),
      ]),
    ).sort();
    const list = names.length > 0 ? names.join(", ") : "(none defined)";
    throw Object.assign(new Error(`unknown profile "${name}"`), {
      hint: `available profiles: ${list}`,
    });
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  const permissionRules: PermissionRule[] = [];
  const hooks: HookConfig = {};
  const stages = [
    "preToolUse",
    "postToolUse",
    "sessionStart",
    "userPromptSubmit",
    "preCompact",
    "stop",
    "subagentStop",
    "notification",
    "sessionEnd",
  ] as const;
  let merged: Partial<CliConfig> = {};
  for (const src of present) {
    Object.assign(mcpServers, src.mcpServers);
    // higher-precedence sources prepend so their rules win first-match.
    permissionRules.unshift(...(src.permissionRules ?? []));
    for (const stage of stages) {
      const existing = hooks[stage] ?? [];
      if (src.hooks?.[stage]) hooks[stage] = [...existing, ...src.hooks[stage]];
    }
    merged = { ...merged, ...src };
  }
  // `profiles` must not nest inside a profile overlay.
  delete merged.profiles;
  return {
    ...merged,
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
}

/**
 * Precedence: env > CLI flags > --settings file > selected --profile overlay
 *   > .seekforge/config.local.json > project .seekforge/config.json
 *   > ~/.seekforge/config.json
 *
 * config.local.json is the gitignored personal layer (per-developer overrides);
 * it slots just above the shared project config. The --settings layer sits
 * above it. A selected profile (--profile <name> or SEEKFORGE_PROFILE) slots
 * just below --settings and above config.local — its fields override the merged
 * base. The profile is looked up across the file layers (project winning over
 * global on a name clash, local over both), same as the other merges. For
 * deep-merge fields (mcpServers, permissionRules, hooks), each layer — including
 * the profile — is merged into the existing logic rather than replacing
 * wholesale. The `profiles` map itself is stripped from the returned config.
 */
export function loadConfig(projectPath: string, settingsPath?: string, profile?: string): CliConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  const local = readJson(join(projectPath, ".seekforge", "config.local.json"));
  const settings = settingsPath ? readSettingsFile(settingsPath) : {};

  const profileName = profile ?? process.env["SEEKFORGE_PROFILE"] ?? undefined;
  const prof = resolveProfile(profileName, { global, project, local }) ?? {};

  // mcpServers merges per server name (later wins):
  //   settings > profile > local > project > global.
  const mcpServers = {
    ...global.mcpServers,
    ...project.mcpServers,
    ...local.mcpServers,
    ...prof.mcpServers,
    ...settings.mcpServers,
  };
  // permissionRules concatenates settings-then-profile-then-local-then-project-then-global:
  // first match wins, so settings rules take highest precedence among file layers.
  const permissionRules = [
    ...(settings.permissionRules ?? []),
    ...(prof.permissionRules ?? []),
    ...(local.permissionRules ?? []),
    ...(project.permissionRules ?? []),
    ...(global.permissionRules ?? []),
  ];
  // hooks concatenate per stage: global, then project, then local, then profile, then settings.
  const hooks: HookConfig = {};
  for (const stage of [
    "preToolUse",
    "postToolUse",
    "sessionStart",
    "userPromptSubmit",
    "preCompact",
    "stop",
    "subagentStop",
    "notification",
    "sessionEnd",
  ] as const) {
    const merged = [
      ...(global.hooks?.[stage] ?? []),
      ...(project.hooks?.[stage] ?? []),
      ...(local.hooks?.[stage] ?? []),
      ...(prof.hooks?.[stage] ?? []),
      ...(settings.hooks?.[stage] ?? []),
    ];
    if (merged.length > 0) hooks[stage] = merged;
  }
  const result: CliConfig = {
    ...global,
    ...project,
    ...local,
    ...prof,
    ...settings,
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
    ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
  };
  // `profiles` is a selection mechanism, not effective config — never leak it.
  delete result.profiles;
  return result;
}
