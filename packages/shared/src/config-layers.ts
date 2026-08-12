/**
 * Layered config merging — the single implementation of the merge semantics
 * that used to be replicated (and drift: the server once missed the
 * ARK_API_KEY selection and the editFormat key) across apps/cli/src/config.ts,
 * apps/tui/src/config.ts and apps/server/src/config.ts.
 *
 * What is shared here is ONLY the merge algebra. Each app keeps:
 *   - its own config type (CliConfig / TuiConfig / ServerConfig),
 *   - its own layer list (CLI: global/project/local/profile/--settings;
 *     TUI + server: global/project),
 *   - its own KNOWN_CONFIG_KEYS / unknown-key scan and extras (CLI profiles,
 *     --settings file, config.local.json).
 *
 * Every layer carries its ORIGIN, because for one field — mcpServers — "the
 * higher layer wins" is the wrong rule. The repository-owned layers sit ABOVE
 * the user's global config in every app's precedence stack, and in a cloned
 * repository they are attacker-controlled input. Origin is part of the layer
 * type rather than something a caller may pass: a surface that forgets it does
 * not compile. Three surfaces silently missed this rule when it lived one level
 * up, which is the whole reason it lives here now.
 *
 * Merge semantics (layers ordered LOW → HIGH precedence):
 *   - scalars: object-spread in layer order (later layer wins per key);
 *   - mcpServers: merged per server NAME (later layer wins per name) instead
 *     of replacing the whole map — EXCEPT that a repository layer may only
 *     introduce names, never repoint one a user-owned layer defines (see
 *     resolveMcpServerLayers);
 *   - permissionRules: concatenated HIGHER-precedence first — evaluation is
 *     first-match-wins, so higher layers' rules take precedence;
 *   - hooks: concatenated per stage LOWER-precedence first — every hook runs,
 *     lower layers' hooks first;
 *   - env overrides (last step): provider-aware API key (the merged provider's
 *     own variable when it has one — see provider-env.ts — DEEPSEEK_API_KEY
 *     otherwise, so a DeepSeek user who happens to export ARK_API_KEY for
 *     another tool never gets the Ark key sent to the DeepSeek endpoint, and
 *     vice versa) and the SEEKFORGE_RUNTIME_BIN override.
 *
 * NODE-ONLY (process.env + the fs-reading layer helper), so it lives behind
 * the "./config-layers" subpath export and is NOT re-exported from index.ts
 * (the package root must stay browser-safe for the desktop bundle).
 */

import { readFileBounded } from "./bounded-file-read.js";
import { apiKeyEnvVar } from "./provider-env.js";
import {
  HOOK_STAGES,
  type HookEntry,
  type HookStage,
  PERMISSION_LEVEL,
  type PermissionName,
  type PermissionRule,
} from "./index.js";

export const MAX_CONFIG_FILE_BYTES = 1_000_000;

/**
 * The keys mergeConfigLayers treats specially. App config types satisfy this
 * structurally (their mcpServers value types narrow `unknown`; their hooks
 * type is core's HookConfig, which mirrors shared's stage/entry shapes).
 */
export type BaseConfigShape = {
  apiKey?: string;
  /** Provider preset name; drives the env API-key selection ("deepseek" default). */
  provider?: string;
  runtimeBin?: string;
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  permissionRules?: PermissionRule[];
  mcpServers?: Record<string, unknown>;
  hooks?: Partial<Record<HookStage, HookEntry[]>>;
};

/**
 * Who owns the FILE a layer came from. `user` = a layer the repository cannot
 * write (`~/.seekforge/config.json`, an explicit `--settings` file, env);
 * `repository` = anything that ships inside the checkout
 * (`.seekforge/config.json`, `.seekforge/config.local.json`, and the profile
 * overlays read out of either).
 */
export type ConfigLayerOrigin = "user" | "repository";

/** One layer, tagged with its origin. Build these with the two helpers below. */
export type ConfigLayer<T> = {
  origin: ConfigLayerOrigin;
  config: T;
  /**
   * Trust-scoped MCP fields dropped while downgrading this layer. Carried on
   * the layer (rather than recomputed during the merge) because the reduction
   * happens against the RAW file, and by merge time it has already happened.
   */
  narrowed?: readonly McpEntryNarrowing[];
};

/** One repository MCP entry and the trust-scoped fields refused on it. */
export type McpEntryNarrowing = { server: string; fields: string[] };

/** Diagnostics a merge produces, so a narrowing is never invisible. */
export type ConfigMergeReport = {
  /** Origin of every surviving mcpServers name. */
  mcpServerOrigins: Record<string, ConfigLayerOrigin>;
  /** Repository server names refused because a user-owned layer defines them. */
  mcpShadowed: string[];
  /** Repository entries whose trust-scoped fields were refused. */
  mcpNarrowed: McpEntryNarrowing[];
};

/** Tag a layer the repository cannot write. Nothing is reduced. */
export function userConfigLayer<T extends BaseConfigShape>(config: T): ConfigLayer<T> {
  return { origin: "user", config };
}

/**
 * Downgrade a layer that ships inside the checkout AND tag it, in one step, so
 * the two cannot come apart — a layer tagged `repository` but never sanitized
 * would keep exactly the authority the tag exists to remove.
 */
export function repositoryConfigLayer<T extends BaseConfigShape>(raw: T): ConfigLayer<T> {
  const { config, narrowed } = downgradeRepositoryLayer(raw);
  return { origin: "repository", config: config as T, narrowed };
}

export type MergeConfigLayersOptions = {
  /**
   * Stage iteration order for the per-stage hooks concat. Defaults to
   * HOOK_STAGES. Only affects the KEY INSERTION ORDER of the merged hooks
   * object (observable through JSON serialization) — the TUI and server
   * historically iterate with sessionEnd third and pass their own order to
   * stay byte-identical; the CLI matches the default.
   */
  hookStages?: readonly HookStage[];
  /**
   * Default true: apply the provider-aware env API key + SEEKFORGE_RUNTIME_BIN
   * overrides as the final step. Set false for sub-merges that must stay
   * env-free (the CLI's profile-overlay resolution).
   */
  envOverrides?: boolean;
};

/**
 * Repository-owned config is input from the checkout, not a user trust grant.
 * Keep only preferences that cannot choose a credential destination, execute
 * code, widen permissions, weaken isolation, erase audit history, or raise a
 * spending limit. Structured security fields are handled separately below.
 */
const PROJECT_PREFERENCE_KEYS = new Set([
  "model",
  "models",
  "compaction",
  "thinking",
  "reasoningEffort",
  "planModel",
  "editFormat",
  "finalizeReview",
  "guardNoProgress",
  "locale",
  "accent",
  "bell",
  "notify",
  "vim",
  "mouse",
  "routing",
]);

/** Whether `config set` may persist a key in the untrusted project layer. */
export function isProjectConfigKeyAllowed(key: string): boolean {
  return PROJECT_PREFERENCE_KEYS.has(key);
}

/**
 * Lock id for read-modify-write of the USER-owned `~/.seekforge/config.json`.
 *
 * Several processes edit that one file: `seekforge config set --global`, a TUI
 * "always allow", a Desktop approval reaching the server. Each reads the whole
 * document, changes one key, and writes it back, so two of them landing
 * together silently drops one edit — the file stays valid, and the setting the
 * user just made is simply not there. Everyone takes this lease first, keyed on
 * the SeekForge home, so the id has to be identical across all of them: it
 * lives here rather than being retyped in three apps.
 */
export const GLOBAL_CONFIG_LOCK_ID = "seekforge-global-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPermissionRule(value: unknown): value is PermissionRule {
  if (!isRecord(value)) return false;
  return (
    (value.action === "allow" || value.action === "deny") &&
    typeof value.tool === "string" &&
    (value.match === undefined || typeof value.match === "string")
  );
}

function isHookEntry(value: unknown): value is HookEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.command === "string" &&
    (value.match === undefined || typeof value.match === "string") &&
    (value.pattern === undefined || typeof value.pattern === "string")
  );
}

function isPermissionName(value: unknown): value is PermissionName {
  return typeof value === "string" && Object.hasOwn(PERMISSION_LEVEL, value);
}

/**
 * A repository layer may raise the bar on an MCP server, never lower it.
 *
 * PERMISSION_LEVEL runs least → most restrictive (readonly 0 … dangerous 4), so
 * a declared value REPLACES whatever the tool would otherwise have been — and a
 * lower number is wider, not narrower.
 *
 * The floor is `env`, not `write`. There is no single implicit level to compare
 * against: `toolPermission` (packages/core/src/mcp/tools.ts) derives it from the
 * tool's own annotations — `env` for `destructiveHint` or `openWorldHint`,
 * `readonly` for `readOnlyHint`, `write` otherwise. `env` is the highest of
 * those, so `env` and `dangerous` are the only two values that cannot widen
 * ANY tool of the server. A floor of `write` looked safe because `write` is the
 * unannotated default, but it let a repository declare `write` or `execute` on
 * a server whose destructive tools would otherwise have been `env` — turning a
 * prompt the user must answer every time (L3 is never session-grantable) into
 * one that `auto`, and for `write` even `acceptEdits`, approves silently.
 */
function repositoryMayKeepPermission(value: unknown): value is PermissionName {
  return isPermissionName(value) && PERMISSION_LEVEL[value] >= PERMISSION_LEVEL.env;
}

/**
 * Strip what a repository layer may not assert on one MCP entry.
 *
 * `trusted` is refused because connecting starts a process or contacts an
 * endpoint. `permission`/`toolPermissions` below `write` are refused because
 * they are inert while the entry is untrusted but ride along the documented
 * "review this project entry, then copy it to global with `trusted: true`"
 * workflow — which is how a repository-authored `readonly` would become a real
 * grant.
 */
function narrowRepositoryMcpEntry(entry: Record<string, unknown>): {
  entry: Record<string, unknown>;
  fields: string[];
} {
  const result = { ...entry };
  const fields: string[] = [];
  if (Object.hasOwn(result, "trusted") && result["trusted"] !== false) fields.push("trusted");
  delete result["trusted"];
  if (Object.hasOwn(result, "permission") && !repositoryMayKeepPermission(result["permission"])) {
    fields.push("permission");
    delete result["permission"];
  }
  if (isRecord(result["toolPermissions"])) {
    const kept: Record<string, PermissionName> = {};
    for (const [tool, value] of Object.entries(result["toolPermissions"])) {
      if (repositoryMayKeepPermission(value)) kept[tool] = value;
      else fields.push(`toolPermissions.${tool}`);
    }
    if (Object.keys(kept).length > 0) result["toolPermissions"] = kept;
    else delete result["toolPermissions"];
  } else if (Object.hasOwn(result, "toolPermissions")) {
    // A non-object toolPermissions is rejected downstream anyway; drop it so a
    // repository layer cannot make an entry merely look malformed.
    fields.push("toolPermissions");
    delete result["toolPermissions"];
  }
  return { entry: result, fields };
}

/**
 * Downgrade a repository-owned config layer before merging it with user-owned
 * settings. Project deny rules may make policy stricter, but allow rules cannot
 * authorize actions. MCP definitions remain available for explicit inspection,
 * while their trust-scoped fields are refused so only a user-owned layer can
 * grant automatic connection/startup or waive a prompt.
 *
 * This is the ONE-LAYER half of the reduction. The other half — a repository
 * layer must not repoint a server name a user-owned layer defines — cannot be
 * expressed here: this function sees a single layer and has no idea which names
 * the user's own layers claim. That half lives in the merge, which holds the
 * whole list. See resolveMcpServerLayers.
 */
export function sanitizeProjectConfig<T extends BaseConfigShape>(layer: T): T;
export function sanitizeProjectConfig(layer: unknown): BaseConfigShape;
export function sanitizeProjectConfig(layer: unknown): BaseConfigShape {
  return downgradeRepositoryLayer(layer).config;
}

function downgradeRepositoryLayer(layer: unknown): { config: BaseConfigShape; narrowed: McpEntryNarrowing[] } {
  const narrowed: McpEntryNarrowing[] = [];
  if (!isRecord(layer)) return { config: {}, narrowed };
  const source = layer as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of PROJECT_PREFERENCE_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    switch (key) {
      case "model":
      case "planModel":
      case "accent":
        if (typeof value === "string") result[key] = value;
        break;
      case "models":
        if (Array.isArray(value) && value.every((item) => typeof item === "string")) result[key] = [...value];
        break;
      case "compaction":
        if (value === "mechanical" || value === "llm") result[key] = value;
        break;
      case "reasoningEffort":
        if (value === "high" || value === "max") result[key] = value;
        break;
      case "editFormat":
        if (value === "patch" || value === "whole") result[key] = value;
        break;
      case "locale":
        if (value === "en" || value === "zh-CN") result[key] = value;
        break;
      case "thinking":
      case "finalizeReview":
      case "guardNoProgress":
      case "bell":
      case "notify":
      case "vim":
      case "mouse":
        if (typeof value === "boolean") result[key] = value;
        break;
      case "routing":
        if (isRecord(value)) {
          result[key] = typeof value.planModel === "string" ? { planModel: value.planModel } : {};
        }
        break;
    }
  }

  if (Array.isArray(layer.permissionRules)) {
    result.permissionRules = layer.permissionRules.filter(
      (rule): rule is PermissionRule => isPermissionRule(rule) && rule.action === "deny",
    );
  }

  if (isRecord(layer.mcpServers)) {
    const servers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, value] of Object.entries(layer.mcpServers)) {
      if (!isRecord(value)) continue;
      const server = narrowRepositoryMcpEntry(value);
      servers[name] = server.entry;
      if (server.fields.length > 0) narrowed.push({ server: name, fields: server.fields });
    }
    result.mcpServers = servers;
  }

  return { config: result as BaseConfigShape, narrowed };
}

/**
 * The cross-layer half of the MCP reduction: a repository layer may INTRODUCE a
 * server name, but may never take over one a user-owned layer defines — at any
 * precedence, in either direction.
 *
 * Whole-entry replacement is kept deliberately. Merging field by field and
 * "clamping the security fields" would be worse: it splices a repository
 * layer's `args`/`env`/`url`/`oauth` into an entry that still carries the user's
 * `trusted: true`, and those fields are not security fields under any such
 * taxonomy — yet they are the entire attack surface. That turns a fail-closed
 * defect into a fail-open one.
 *
 * Within one origin, later still wins (a `--settings` file overrides the user's
 * global entry; `config.local.json` overrides the shared project config).
 * Non-object entries are skipped rather than allowed to erase a valid lower
 * layer, matching the rest of the merge.
 */
export function resolveMcpServerLayers<T extends BaseConfigShape>(
  layers: readonly ConfigLayer<T>[],
): { servers: Record<string, unknown>; defined: boolean; report: ConfigMergeReport } {
  const userOwned = new Set<string>();
  for (const layer of layers) {
    if (layer.origin !== "user" || !isRecord(layer.config.mcpServers)) continue;
    for (const [name, value] of Object.entries(layer.config.mcpServers)) {
      if (isRecord(value)) userOwned.add(name);
    }
  }

  // Null-prototype accumulators: a server literally named "__proto__" must
  // become a data property, not a prototype assignment.
  const servers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const mcpServerOrigins = Object.create(null) as Record<string, ConfigLayerOrigin>;
  const shadowed = new Set<string>();
  let defined = false;

  for (const layer of layers) {
    if (!isRecord(layer.config.mcpServers)) continue;
    defined = true;
    for (const [name, value] of Object.entries(layer.config.mcpServers)) {
      if (!isRecord(value)) continue;
      if (layer.origin === "repository" && userOwned.has(name)) {
        shadowed.add(name);
        continue;
      }
      servers[name] = value;
      mcpServerOrigins[name] = layer.origin;
    }
  }

  const mcpNarrowed = new Map<string, Set<string>>();
  for (const layer of layers) {
    for (const entry of layer.narrowed ?? []) {
      // A narrowing on an entry that lost the name anyway is not worth reporting.
      if (mcpServerOrigins[entry.server] !== "repository") continue;
      const seen = mcpNarrowed.get(entry.server) ?? new Set<string>();
      for (const field of entry.fields) seen.add(field);
      mcpNarrowed.set(entry.server, seen);
    }
  }

  return {
    servers,
    defined,
    report: {
      mcpServerOrigins: { ...mcpServerOrigins },
      mcpShadowed: [...shadowed].sort(),
      mcpNarrowed: [...mcpNarrowed.entries()]
        .map(([server, fields]) => ({ server, fields: [...fields].sort() }))
        .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0)),
    },
  };
}

/**
 * Merges config layers (LOW → HIGH precedence) with the semantics documented
 * in the module header. Pure over its inputs except for reading process.env
 * when envOverrides is on.
 */
export function mergeConfigLayers<T extends BaseConfigShape>(
  layers: readonly ConfigLayer<T>[],
  opts: MergeConfigLayersOptions = {},
): T {
  return mergeConfigLayersWithReport(layers, opts).config;
}

/**
 * mergeConfigLayers plus the diagnostics. A surface that can show the user why
 * their config was narrowed should use this one; a narrowing nobody can see is
 * its own defect.
 */
export function mergeConfigLayersWithReport<T extends BaseConfigShape>(
  tagged: readonly ConfigLayer<T>[],
  opts: MergeConfigLayersOptions = {},
): { config: T; report: ConfigMergeReport } {
  const hookStages = opts.hookStages ?? HOOK_STAGES;
  const layers = tagged.map((layer) => layer.config);

  // mcpServers merges per server name (later layer wins) — except that a
  // repository layer cannot take a name a user-owned layer defines.
  const mcp = resolveMcpServerLayers(tagged);
  const mcpServers = mcp.servers;
  const hasMcpServers = mcp.defined;

  // permissionRules concatenate higher-precedence layers first: evaluation is
  // first-match-wins, so a higher layer's rule beats a lower one's.
  const permissionRules: PermissionRule[] = [];
  let hasPermissionRules = false;
  for (const layer of layers) {
    if (!Array.isArray(layer.permissionRules)) continue;
    permissionRules.unshift(...layer.permissionRules.filter(isPermissionRule));
    hasPermissionRules = true;
  }

  // hooks concatenate per stage, lower-precedence layers first: every hook
  // runs. (Without this, the scalar spread below would let a higher layer's
  // hooks object REPLACE a lower one's wholesale.)
  const hooks: Partial<Record<HookStage, HookEntry[]>> = {};
  let hasHooks = false;
  for (const stage of hookStages) {
    const merged = layers.flatMap((layer) => {
      if (!isRecord(layer.hooks)) return [];
      hasHooks = true;
      const entries = layer.hooks[stage];
      return Array.isArray(entries) ? entries.filter(isHookEntry) : [];
    });
    if (merged.length > 0) hooks[stage] = merged;
  }

  // Scalars: plain spread in layer order (later layer wins per key).
  let scalars: Record<string, unknown> = {};
  for (const layer of layers) scalars = { ...scalars, ...(layer as Record<string, unknown>) };
  delete scalars.apiKey;
  delete scalars.provider;
  delete scalars.runtimeBin;
  delete scalars.sandbox;
  delete scalars.permissionRules;
  delete scalars.mcpServers;
  delete scalars.hooks;

  let apiKey: string | undefined;
  let provider: string | undefined;
  let runtimeBin: string | undefined;
  let sandbox: BaseConfigShape["sandbox"];
  for (const layer of layers) {
    if (typeof layer.apiKey === "string") apiKey = layer.apiKey;
    if (typeof layer.provider === "string") provider = layer.provider;
    if (typeof layer.runtimeBin === "string") runtimeBin = layer.runtimeBin;
    if (
      layer.sandbox === "off" ||
      layer.sandbox === "read-only" ||
      layer.sandbox === "workspace-write" ||
      layer.sandbox === "restricted"
    )
      sandbox = layer.sandbox;
  }

  // Env overrides (final step). The provider is resolved with ??-semantics
  // from the highest layer down (a JSON `null` falls through to lower layers,
  // exactly like the historical per-app `a ?? b ?? … ?? "deepseek"` chains).
  let envOverrides: Record<string, unknown> = {};
  if (opts.envOverrides !== false) {
    const envKey = process.env[apiKeyEnvVar(provider)];
    envOverrides = {
      ...(envKey ? { apiKey: envKey } : {}),
      ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
    };
  }

  return {
    config: {
      ...scalars,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(runtimeBin !== undefined ? { runtimeBin } : {}),
      ...(sandbox !== undefined ? { sandbox } : {}),
      // Preserve explicit empty structured values while leaving keys absent when
      // no layer supplied a valid value.
      ...(hasPermissionRules ? { permissionRules } : {}),
      ...(hasMcpServers ? { mcpServers: { ...mcpServers } } : {}),
      ...(hasHooks ? { hooks } : {}),
      ...envOverrides,
    } as T,
    report: mcp.report,
  };
}

/**
 * One line per reduction, in English, for a surface that has a usable stderr.
 * Empty when nothing was reduced, so a caller can iterate unconditionally.
 */
export function describeConfigMergeReport(report: ConfigMergeReport): string[] {
  const lines: string[] = [];
  for (const name of report.mcpShadowed) {
    lines.push(
      `warning: MCP server "${name}" is defined by this repository and by your own config; ` +
        `the repository definition was ignored (a repository cannot repoint a server you own)\n`,
    );
  }
  for (const { server, fields } of report.mcpNarrowed) {
    lines.push(
      `warning: MCP server "${server}" is repository-owned; ignored ${fields.join(", ")} ` +
        `(a repository layer may only make a server stricter)\n`,
    );
  }
  return lines;
}

/**
 * Reads one JSON config layer, returning {} when the file is absent,
 * unreadable or unparseable (a broken layer must never take the app down —
 * doctor's configParseErrors surfaces it instead).
 *
 * `requireObject` also collapses parseable-but-non-object JSON (null / 42 /
 * "x" / [...]) to {} — JSON.parse accepts those and spreading them downstream
 * misbehaves. All application config loaders enable this guard.
 */
export function readJsonConfigLayer<T extends object>(path: string, opts: { requireObject?: boolean } = {}): T {
  try {
    const parsed = JSON.parse(readFileBounded(path, MAX_CONFIG_FILE_BYTES).toString("utf8")) as unknown;
    if (opts.requireObject && !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))) {
      return {} as T;
    }
    return parsed as T;
  } catch {
    return {} as T;
  }
}
