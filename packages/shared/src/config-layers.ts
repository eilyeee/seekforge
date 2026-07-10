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
 * Merge semantics (layers ordered LOW → HIGH precedence):
 *   - scalars: object-spread in layer order (later layer wins per key);
 *   - mcpServers: merged per server NAME (later layer wins per name) instead
 *     of replacing the whole map;
 *   - permissionRules: concatenated HIGHER-precedence first — evaluation is
 *     first-match-wins, so higher layers' rules take precedence;
 *   - hooks: concatenated per stage LOWER-precedence first — every hook runs,
 *     lower layers' hooks first;
 *   - env overrides (last step): provider-aware API key (ARK_API_KEY when the
 *     merged provider is "ark", DEEPSEEK_API_KEY otherwise — so a DeepSeek
 *     user who happens to export ARK_API_KEY for another tool never gets the
 *     Ark key sent to the DeepSeek endpoint, and vice versa) and the
 *     SEEKFORGE_RUNTIME_BIN override.
 *
 * NODE-ONLY (process.env + the fs-reading layer helper), so it lives behind
 * the "./config-layers" subpath export and is NOT re-exported from index.ts
 * (the package root must stay browser-safe for the desktop bundle).
 */

import { readFileSync } from "node:fs";
import { HOOK_STAGES, type HookEntry, type HookStage, type PermissionRule } from "./index.js";

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
  permissionRules?: PermissionRule[];
  mcpServers?: Record<string, unknown>;
  hooks?: Partial<Record<HookStage, HookEntry[]>>;
};

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
 * Merges config layers (LOW → HIGH precedence) with the semantics documented
 * in the module header. Pure over its inputs except for reading process.env
 * when envOverrides is on.
 */
export function mergeConfigLayers<T extends BaseConfigShape>(
  layers: readonly T[],
  opts: MergeConfigLayersOptions = {},
): T {
  const hookStages = opts.hookStages ?? HOOK_STAGES;

  // mcpServers merges per server name (later layer wins).
  const mcpServers: Record<string, unknown> = {};
  for (const layer of layers) Object.assign(mcpServers, layer.mcpServers);

  // permissionRules concatenate higher-precedence layers first: evaluation is
  // first-match-wins, so a higher layer's rule beats a lower one's.
  const permissionRules: PermissionRule[] = [];
  for (const layer of layers) permissionRules.unshift(...(layer.permissionRules ?? []));

  // hooks concatenate per stage, lower-precedence layers first: every hook
  // runs. (Without this, the scalar spread below would let a higher layer's
  // hooks object REPLACE a lower one's wholesale.)
  const hooks: Partial<Record<HookStage, HookEntry[]>> = {};
  for (const stage of hookStages) {
    const merged = layers.flatMap((layer) => layer.hooks?.[stage] ?? []);
    if (merged.length > 0) hooks[stage] = merged;
  }

  // Scalars: plain spread in layer order (later layer wins per key).
  let scalars: Record<string, unknown> = {};
  for (const layer of layers) scalars = { ...scalars, ...(layer as Record<string, unknown>) };

  // Env overrides (final step). The provider is resolved with ??-semantics
  // from the highest layer down (a JSON `null` falls through to lower layers,
  // exactly like the historical per-app `a ?? b ?? … ?? "deepseek"` chains).
  let envOverrides: Record<string, unknown> = {};
  if (opts.envOverrides !== false) {
    let provider: string | undefined;
    for (const layer of layers) provider = layer.provider ?? provider;
    const mergedProvider = (provider ?? "deepseek").toLowerCase();
    const envKey =
      mergedProvider === "ark" ? process.env["ARK_API_KEY"] : process.env["DEEPSEEK_API_KEY"];
    envOverrides = {
      ...(envKey ? { apiKey: envKey } : {}),
      ...(process.env["SEEKFORGE_RUNTIME_BIN"]
        ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] }
        : {}),
    };
  }

  return {
    ...scalars,
    // Empty merges intentionally add no key: a `permissionRules: []` (etc.)
    // present in some layer survives via the scalar spread, and absent-in-all
    // stays absent — tests assert `undefined` in that case.
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...envOverrides,
  } as T;
}

/**
 * Reads one JSON config layer, returning {} when the file is absent,
 * unreadable or unparseable (a broken layer must never take the app down —
 * doctor's configParseErrors surfaces it instead).
 *
 * `requireObject` also collapses parseable-but-non-object JSON (null / 42 /
 * "x" / [...]) to {} — JSON.parse accepts those and spreading them downstream
 * misbehaves. The CLI turned this guard on long ago; the TUI and server
 * historically did NOT (their layers pass through as-parsed), so it is opt-in
 * to keep each app byte-identical.
 */
export function readJsonConfigLayer<T extends object>(
  path: string,
  opts: { requireObject?: boolean } = {},
): T {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (opts.requireObject && !(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))) {
      return {} as T;
    }
    return parsed as T;
  } catch {
    return {} as T;
  }
}
