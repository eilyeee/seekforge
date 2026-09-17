import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { compareByCodePoints } from "@seekforge/shared";
import type { PluginSupplyChainEntry } from "@seekforge/shared";
import { seekforgeHome } from "../memory/store.js";
import type { HookConfig, HookEntry, HookStage } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/types.js";
import { readWorkspaceStateFile } from "../util/workspace-state.js";
import { BUILTIN_GRAPH_HANDLER_IDS } from "../agent/graph-declarative-handlers.js";
import { lspServersSchema, parseLspServerConfig } from "../tools/lsp/config.js";
import { CLAUDE_PLUGIN_MANIFEST, translateClaudePlugin } from "./claude.js";
import {
  PLUGIN_API_VERSION,
  type LspServerConfig,
  type PluginContributions,
  type PluginFormat,
  type PluginManifest,
  type PluginOrigin,
  type PluginRecord,
  type PluginScope,
} from "./types.js";

export const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
export const MAX_PLUGIN_FILES = 1_000;
export const MAX_PLUGIN_BYTES = 10 * 1024 * 1024;
export const PLUGIN_STATE_REL_PATH = ".seekforge/plugins-state.json";

const permission = z.enum(["readonly", "write", "execute", "env", "dangerous"]);
const hookEntry = z
  .object({ match: z.string().optional(), pattern: z.string().optional(), command: z.string().min(1) })
  .strict();
const hookConfig = z
  .object({
    preToolUse: z.array(hookEntry).optional(),
    postToolUse: z.array(hookEntry).optional(),
    sessionStart: z.array(hookEntry).optional(),
    userPromptSubmit: z.array(hookEntry).optional(),
    preCompact: z.array(hookEntry).optional(),
    stop: z.array(hookEntry).optional(),
    subagentStop: z.array(hookEntry).optional(),
    notification: z.array(hookEntry).optional(),
    sessionEnd: z.array(hookEntry).optional(),
  })
  .strict();
const mcpServer = z
  .object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z
      .object({
        tokenEndpoint: z.string().min(1),
        clientId: z.string().min(1),
        clientSecret: z.string().optional(),
        refreshToken: z.string().min(1),
        scope: z.string().optional(),
      })
      .strict()
      .optional(),
    trusted: z.boolean().optional(),
    permission: permission.optional(),
    toolPermissions: z.record(z.string(), permission).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const command = typeof value.command === "string" && value.command.trim() !== "";
    const url = typeof value.url === "string" && value.url.trim() !== "";
    if (command === url) ctx.addIssue({ code: "custom", message: "MCP server needs exactly one command or url" });
    if (command && value.oauth) ctx.addIssue({ code: "custom", message: "stdio MCP server cannot use oauth" });
  });
const manifestSchema = z
  .object({
    apiVersion: z.literal(PLUGIN_API_VERSION),
    id: z.string().regex(PLUGIN_ID_RE),
    name: z.string().min(1).max(120),
    // SemVer, including the optional pre-release and build-metadata parts.
    version: z
      .string()
      .max(100)
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    description: z.string().max(2_000).optional(),
    seekforge: z.string().max(100).optional(),
    contributes: z
      .object({
        skillRoots: z.array(z.string()).max(20).optional(),
        agentRoots: z.array(z.string()).max(20).optional(),
        commandRoots: z.array(z.string()).max(20).optional(),
        outputStyleRoots: z.array(z.string()).max(20).optional(),
        lspServers: lspServersSchema.optional(),
        mcpServers: z.record(z.string().regex(PLUGIN_ID_RE), mcpServer).optional(),
        hooks: hookConfig.optional(),
        graphHandlers: z.record(z.string().regex(PLUGIN_ID_RE), z.enum(BUILTIN_GRAPH_HANDLER_IDS)).optional(),
        graphExecutors: z.record(z.string().regex(PLUGIN_ID_RE), z.string().regex(PLUGIN_ID_RE)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type PluginState = {
  version: 1;
  plugins: Record<string, { enabled: boolean; digest: string; updatedAt: string; origin?: PluginOrigin }>;
};

function safeRelativePath(value: string): boolean {
  if (value === "" || isAbsolute(value)) return false;
  const normalized = resolve("/plugin", value);
  const rel = relative("/plugin", normalized);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function globalPluginsRoot(): string {
  return join(seekforgeHome(), ".seekforge", "plugins");
}

export function projectPluginsRoot(workspace: string): string {
  return join(workspace, ".seekforge", "plugins");
}

/** Resolves a physical plugin store without following symlinked child components. */
export function resolvePluginStoreRoot(base: string, create: boolean): string | undefined {
  return resolvePluginStateDir(base, "plugins", create);
}

/**
 * `<base>/.seekforge/<name>` as a physical directory (created 0700 when
 * `create` is set), refusing any symlinked or non-directory component below
 * `base`. The one walk behind the plugin store and the marketplace cache.
 */
export function resolvePluginStateDir(
  base: string,
  name: "plugins" | "plugin-marketplaces",
  create: boolean,
): string | undefined {
  let current = realpathSync(resolve(base));
  for (const part of [".seekforge", name]) {
    current = join(current, part);
    let stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined && create) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      stat = lstatSync(current, { throwIfNoEntry: false });
    }
    if (stat === undefined) return undefined;
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(current) !== current) {
      throw new Error(`plugin store path must be a physical directory: ${current}`);
    }
  }
  return current;
}

function pluginState(): PluginState {
  try {
    const raw = readWorkspaceStateFile(seekforgeHome(), PLUGIN_STATE_REL_PATH, MAX_PLUGIN_MANIFEST_BYTES);
    if (raw === undefined) return { version: 1, plugins: {} };
    const value = JSON.parse(raw) as PluginState;
    if (value.version !== 1 || typeof value.plugins !== "object" || value.plugins === null)
      return { version: 1, plugins: {} };
    return value;
  } catch {
    return { version: 1, plugins: {} };
  }
}

export function readPluginManifest(dir: string): PluginManifest {
  return readPluginManifestDetailed(dir).manifest;
}

function readBoundedManifest(manifestPath: string, label: string): unknown {
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(`${label} must be a bounded regular file`);
  }
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/**
 * Read a plugin directory's manifest: SeekForge's `plugin.json`, or — when
 * that is absent — Claude Code's `.claude-plugin/plugin.json`, translated
 * (see claude.ts). `warnings` lists what a Claude Code plugin ships that
 * SeekForge could not map.
 */
export function readPluginManifestDetailed(dir: string): {
  manifest: PluginManifest;
  format: PluginFormat;
  warnings: string[];
} {
  const lexical = resolve(dir);
  const rootStat = lstatSync(lexical);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("plugin root must be a real directory");
  const root = realpathSync(lexical);
  const manifestPath = join(root, "plugin.json");
  if (lstatSync(manifestPath, { throwIfNoEntry: false }) === undefined) {
    const claudePath = join(root, CLAUDE_PLUGIN_MANIFEST);
    const claudeDir = lstatSync(join(root, ".claude-plugin"), { throwIfNoEntry: false });
    if (claudeDir?.isDirectory() && !claudeDir.isSymbolicLink() && lstatSync(claudePath, { throwIfNoEntry: false })) {
      const translated = translateClaudePlugin(root, readBoundedManifest(claudePath, ".claude-plugin/plugin.json"));
      // The translation already confined every root; re-check with the same
      // rules as a native manifest so both shapes share one gate.
      assertConfinedRoots(root, translated.manifest);
      return { manifest: translated.manifest, format: "claude", warnings: translated.warnings };
    }
  }
  const parsed = manifestSchema.safeParse(readBoundedManifest(manifestPath, "plugin.json"));
  if (!parsed.success) throw new Error(`invalid plugin.json: ${parsed.error.issues[0]?.message ?? "invalid manifest"}`);
  const manifest = parsed.data as PluginManifest;
  assertConfinedRoots(root, manifest);
  return { manifest, format: "seekforge", warnings: [] };
}

function assertConfinedRoots(root: string, manifest: PluginManifest): void {
  const contributes = manifest.contributes;
  for (const path of [
    ...(contributes?.skillRoots ?? []),
    ...(contributes?.agentRoots ?? []),
    ...(contributes?.commandRoots ?? []),
    ...(contributes?.outputStyleRoots ?? []),
  ]) {
    if (!safeRelativePath(path)) throw new Error(`plugin contribution path is unsafe: ${path}`);
    let physical: string;
    try {
      physical = realpathSync(resolve(root, path));
    } catch {
      throw new Error(`plugin contribution directory is missing: ${path}`);
    }
    if (!physical.startsWith(`${root}${sep}`) || !statSync(physical).isDirectory()) {
      throw new Error(`plugin contribution path is not a confined directory: ${path}`);
    }
  }
}

/** Hashes only regular files and rejects links/devices, bounding install and approval work. */
export function digestPluginDirectory(dir: string): string {
  const root = realpathSync(resolve(dir));
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (current: string): void => {
    // Code units, not a collator: this order decides the hash, so an approval
    // that means "exactly this content" must not also depend on the locale of
    // the machine reading it. Under sv-SE "ä" sorts after "z" and under en-US
    // beside "a" — same directory, different sha256, and a plugin approved on
    // one machine reading as "changed" on another.
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      compareByCodePoints(a.name, b.name),
    )) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`plugin contains a symbolic link: ${relative(root, path)}`);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !stat.isFile())
        throw new Error(`plugin contains a non-regular file: ${relative(root, path)}`);
      files++;
      bytes += stat.size;
      if (files > MAX_PLUGIN_FILES || bytes > MAX_PLUGIN_BYTES)
        throw new Error("plugin exceeds file-count or byte limits");
      const rel = relative(root, path);
      hash.update(rel).update("\0").update(readFileSync(path)).update("\0");
    }
  };
  visit(root);
  return hash.digest("hex");
}

function contributionPath(root: string, rel: string): string | undefined {
  const target = resolve(root, rel);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return undefined;
  try {
    const physical = realpathSync(target);
    const stat = statSync(physical);
    return stat.isDirectory() && (physical === root || physical.startsWith(`${root}${sep}`)) ? physical : undefined;
  } catch {
    return undefined;
  }
}

function readRoot(root: string, scope: PluginScope, state: PluginState): PluginRecord[] {
  let names: string[];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PLUGIN_ID_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name): PluginRecord => {
    const path = join(root, name);
    try {
      const { manifest, format, warnings } = readPluginManifestDetailed(path);
      if (manifest.id !== name) throw new Error(`manifest id ${manifest.id} does not match directory ${name}`);
      const digest = digestPluginDirectory(path);
      const described = { format, ...(warnings.length > 0 ? { warnings } : {}) };
      if (scope === "project")
        return { id: name, scope, path, status: "review_required", digest, manifest, ...described };
      const approval = state.plugins[name];
      const status = approval?.enabled ? (approval.digest === digest ? "enabled" : "changed") : "disabled";
      return {
        id: name,
        scope,
        path,
        status,
        digest,
        manifest,
        ...described,
        ...(approval?.origin ? { origin: approval.origin } : {}),
      };
    } catch (error) {
      return {
        id: name,
        scope,
        path,
        status: "invalid",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

export function listPlugins(workspace: string): PluginRecord[] {
  const state = pluginState();
  let globalRoot: string | undefined;
  let projectRoot: string | undefined;
  try {
    globalRoot = resolvePluginStoreRoot(seekforgeHome(), false);
  } catch {
    globalRoot = undefined;
  }
  try {
    projectRoot = resolvePluginStoreRoot(workspace, false);
  } catch {
    projectRoot = undefined;
  }
  return [
    ...(globalRoot ? readRoot(globalRoot, "global", state) : []),
    ...(projectRoot ? readRoot(projectRoot, "project", state) : []),
  ];
}

export function pluginSupplyChainReport(workspace: string): { generatedAt: string; entries: PluginSupplyChainEntry[] } {
  const state = pluginState();
  const entries = listPlugins(workspace).map((plugin): PluginSupplyChainEntry => {
    const lockedDigest = plugin.scope === "global" ? state.plugins[plugin.id]?.digest : undefined;
    const contributions = plugin.manifest?.contributes;
    const capabilities = [
      ...(contributions?.skillRoots?.length ? ["skills"] : []),
      ...(contributions?.agentRoots?.length ? ["agents"] : []),
      ...(contributions?.commandRoots?.length ? ["commands"] : []),
      ...(contributions?.outputStyleRoots?.length ? ["output-styles"] : []),
      ...(Object.keys(contributions?.mcpServers ?? {}).length ? ["mcp"] : []),
      ...(Object.keys(contributions?.lspServers ?? {}).length ? ["lsp"] : []),
      ...(Object.keys(contributions?.hooks ?? {}).length ? ["hooks"] : []),
      ...(Object.keys(contributions?.graphHandlers ?? {}).length ? ["graph-handlers"] : []),
      ...(Object.keys(contributions?.graphExecutors ?? {}).length ? ["graph-executors"] : []),
    ];
    return {
      id: plugin.id,
      scope: plugin.scope,
      status: plugin.status,
      ...(plugin.manifest ? { version: plugin.manifest.version } : {}),
      ...(plugin.digest ? { digest: plugin.digest } : {}),
      ...(lockedDigest ? { lockedDigest } : {}),
      integrity:
        plugin.status === "invalid"
          ? "invalid"
          : lockedDigest === undefined
            ? "unlocked"
            : lockedDigest === plugin.digest
              ? "verified"
              : "changed",
      rollbackAvailable: plugin.scope === "global" && existsSync(join(dirname(plugin.path), `.rollback-${plugin.id}`)),
      capabilities,
      compatibility: {
        apiVersion: plugin.manifest?.apiVersion ?? 0,
        compatible: plugin.manifest?.apiVersion === PLUGIN_API_VERSION,
        ...(plugin.manifest?.seekforge ? { seekforge: plugin.manifest.seekforge } : {}),
      },
    };
  });
  return { generatedAt: new Date().toISOString(), entries };
}

const HOOK_STAGES: HookStage[] = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
  "sessionEnd",
];

function mergeHooks(target: HookConfig, incoming: HookConfig | undefined): void {
  if (!incoming) return;
  for (const stage of HOOK_STAGES) {
    const entries = incoming[stage] as HookEntry[] | undefined;
    if (entries?.length)
      (target[stage] as HookEntry[] | undefined) = [...((target[stage] as HookEntry[] | undefined) ?? []), ...entries];
  }
}

export function loadPluginContributions(workspace: string): PluginContributions {
  const plugins = listPlugins(workspace);
  const result: PluginContributions = {
    skillRoots: [],
    agentRoots: [],
    commandRoots: [],
    outputStyleRoots: [],
    mcpServers: {},
    lspServers: {},
    hooks: {},
    graphHandlers: {},
    graphExecutors: {},
    plugins,
  };
  for (const plugin of plugins) {
    if (plugin.scope !== "global" || plugin.status !== "enabled" || !plugin.manifest) continue;
    const root = realpathSync(plugin.path);
    for (const rel of plugin.manifest.contributes?.skillRoots ?? []) {
      const path = contributionPath(root, rel);
      if (path) result.skillRoots.push(path);
    }
    for (const rel of plugin.manifest.contributes?.agentRoots ?? []) {
      const path = contributionPath(root, rel);
      if (path) result.agentRoots.push(path);
    }
    for (const rel of plugin.manifest.contributes?.commandRoots ?? []) {
      const path = contributionPath(root, rel);
      if (path) result.commandRoots!.push({ plugin: plugin.id, path });
    }
    for (const rel of plugin.manifest.contributes?.outputStyleRoots ?? []) {
      const path = contributionPath(root, rel);
      if (path) result.outputStyleRoots!.push({ plugin: plugin.id, path });
    }
    for (const [name, raw] of Object.entries(plugin.manifest.contributes?.lspServers ?? {})) {
      const parsed = parseLspServerConfig(raw);
      if (parsed.config) result.lspServers![`${plugin.id}:${name}`] = parsed.config;
    }
    for (const [name, config] of Object.entries(plugin.manifest.contributes?.mcpServers ?? {})) {
      // Enabling a plugin authorizes what the reviewed manifest declares, not
      // more: connection trust is granted only where the manifest itself says
      // `trusted: true`, so the approved digest covers that grant and an
      // explicit `false` is never widened. Omitted keeps the McpServerConfig
      // default (untrusted), which is what a reader of a manifest without the
      // field expects and what docs/mcp.md's trust model promises.
      result.mcpServers[`${plugin.id}__${name}`] = { ...config, trusted: config.trusted === true };
    }
    mergeHooks(result.hooks, plugin.manifest.contributes?.hooks);
    for (const [name, handler] of Object.entries(plugin.manifest.contributes?.graphHandlers ?? {})) {
      result.graphHandlers![`${plugin.id}__${name}`] = handler;
    }
    for (const [name, executor] of Object.entries(plugin.manifest.contributes?.graphExecutors ?? {})) {
      result.graphExecutors![`${plugin.id}__${name}`] = executor;
    }
  }
  return result;
}

export function mergePluginHooks(
  workspace: string,
  configured: HookConfig | undefined,
  contributions = loadPluginContributions(workspace),
): HookConfig | undefined {
  const pluginHooks = contributions.hooks;
  const merged: HookConfig = {};
  mergeHooks(merged, pluginHooks);
  mergeHooks(merged, configured);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * The language-server table a host hands to configureLspServers: plugin
 * servers (named `<plugin>:<server>`) plus the user's `lspServers` config,
 * which wins for any extension both claim.
 */
export function mergePluginLspServers(
  workspace: string,
  configured: Record<string, unknown> | undefined,
  contributions = loadPluginContributions(workspace),
): { plugin: Record<string, LspServerConfig>; user?: Record<string, unknown> } {
  return { plugin: { ...(contributions.lspServers ?? {}) }, ...(configured ? { user: configured } : {}) };
}

export function mergePluginMcpServers(
  workspace: string,
  configured: Record<string, McpServerConfig> | undefined,
  contributions = loadPluginContributions(workspace),
): Record<string, McpServerConfig> {
  return { ...contributions.mcpServers, ...(configured ?? {}) };
}

export type { PluginState };
