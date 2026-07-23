import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { seekforgeHome } from "../memory/store.js";
import type { HookConfig, HookEntry, HookStage } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/types.js";
import { readWorkspaceStateFile } from "../util/workspace-state.js";
import {
  PLUGIN_API_VERSION,
  type PluginContributions,
  type PluginManifest,
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
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    description: z.string().max(2_000).optional(),
    seekforge: z.string().max(100).optional(),
    contributes: z
      .object({
        skillRoots: z.array(z.string()).max(20).optional(),
        agentRoots: z.array(z.string()).max(20).optional(),
        mcpServers: z.record(z.string().regex(PLUGIN_ID_RE), mcpServer).optional(),
        hooks: hookConfig.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type PluginState = { version: 1; plugins: Record<string, { enabled: boolean; digest: string; updatedAt: string }> };

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
  let current = realpathSync(resolve(base));
  for (const part of [".seekforge", "plugins"]) {
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
  const lexical = resolve(dir);
  const rootStat = lstatSync(lexical);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("plugin root must be a real directory");
  const root = realpathSync(lexical);
  const manifestPath = join(root, "plugin.json");
  const manifestStat = lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.size > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error("plugin.json must be a bounded regular file");
  }
  const parsed = manifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (!parsed.success) throw new Error(`invalid plugin.json: ${parsed.error.issues[0]?.message ?? "invalid manifest"}`);
  for (const path of [...(parsed.data.contributes?.skillRoots ?? []), ...(parsed.data.contributes?.agentRoots ?? [])]) {
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
  return parsed.data as PluginManifest;
}

/** Hashes only regular files and rejects links/devices, bounding install and approval work. */
export function digestPluginDirectory(dir: string): string {
  const root = realpathSync(resolve(dir));
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
      const manifest = readPluginManifest(path);
      if (manifest.id !== name) throw new Error(`manifest id ${manifest.id} does not match directory ${name}`);
      const digest = digestPluginDirectory(path);
      if (scope === "project") return { id: name, scope, path, status: "review_required", digest, manifest };
      const approval = state.plugins[name];
      const status = approval?.enabled ? (approval.digest === digest ? "enabled" : "changed") : "disabled";
      return { id: name, scope, path, status, digest, manifest };
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
  const result: PluginContributions = { skillRoots: [], agentRoots: [], mcpServers: {}, hooks: {}, plugins };
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
    for (const [name, config] of Object.entries(plugin.manifest.contributes?.mcpServers ?? {})) {
      result.mcpServers[`${plugin.id}__${name}`] = { ...config, trusted: true };
    }
    mergeHooks(result.hooks, plugin.manifest.contributes?.hooks);
  }
  return result;
}

export function mergePluginHooks(workspace: string, configured: HookConfig | undefined): HookConfig | undefined {
  const pluginHooks = loadPluginContributions(workspace).hooks;
  const merged: HookConfig = {};
  mergeHooks(merged, pluginHooks);
  mergeHooks(merged, configured);
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function mergePluginMcpServers(
  workspace: string,
  configured: Record<string, McpServerConfig> | undefined,
): Record<string, McpServerConfig> {
  return { ...loadPluginContributions(workspace).mcpServers, ...(configured ?? {}) };
}

export type { PluginState };
