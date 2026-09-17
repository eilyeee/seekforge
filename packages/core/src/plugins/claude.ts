import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { HookConfig, HookEntry, HookStage } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/types.js";
import { hookMatcherTools } from "../skills/tool-rules.js";
import { parseLspServerConfig } from "../tools/lsp/config.js";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import { PLUGIN_API_VERSION, type LspServerConfig, type PluginManifest } from "./types.js";

/**
 * Claude Code plugins (`.claude-plugin/plugin.json`), read as SeekForge
 * manifests.
 *
 * The translation is a pure function of the plugin directory, so the digest a
 * user approved covers everything it produces. What cannot be mapped is
 * reported in `warnings` and left out; nothing is guessed. The components:
 *
 *   skills/            → skillRoots (plus manifest `skills`, which adds)
 *   agents/            → agentRoots (manifest `agents` replaces)
 *   commands/          → commandRoots, named `<plugin>:<command>` (replaces)
 *   output-styles/     → outputStyleRoots (manifest `outputStyles` replaces)
 *   hooks/hooks.json   → hooks (manifest `hooks`: path(s) or inline)
 *   .mcp.json          → mcpServers (manifest `mcpServers`: path(s) or inline)
 *   .lsp.json          → lspServers (manifest `lspServers`: path(s) or inline)
 */

export const CLAUDE_PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");
const MAX_COMPONENT_FILE_BYTES = 256 * 1024;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const PLUGIN_ROOT_VAR = /\$\{CLAUDE_PLUGIN_ROOT\}/g;

const pathList = z.union([z.string(), z.array(z.string()).max(32)]);
const inlineOrPaths = z.union([z.string(), z.array(z.string()).max(32), z.record(z.string(), z.unknown())]);
const claudeManifestSchema = z
  .object({
    name: z.string().regex(NAME_RE, "name must be kebab-case (lowercase letters, digits, dashes)"),
    version: z.string().max(100).optional(),
    description: z.string().optional(),
    skills: pathList.optional(),
    agents: pathList.optional(),
    commands: pathList.optional(),
    outputStyles: pathList.optional(),
    hooks: inlineOrPaths.optional(),
    mcpServers: inlineOrPaths.optional(),
    lspServers: inlineOrPaths.optional(),
  })
  .passthrough();

const hookHandler = z.object({ type: z.string(), command: z.string().optional() }).passthrough();
const hookGroup = z.object({ matcher: z.string().optional(), hooks: z.array(hookHandler) }).passthrough();
const hooksFileSchema = z.object({ hooks: z.record(z.string(), z.array(hookGroup)) }).passthrough();

/** Claude Code event names SeekForge has a stage for. */
const HOOK_EVENTS: Readonly<Record<string, HookStage>> = {
  PreToolUse: "preToolUse",
  PostToolUse: "postToolUse",
  SessionStart: "sessionStart",
  UserPromptSubmit: "userPromptSubmit",
  PreCompact: "preCompact",
  Stop: "stop",
  SubagentStop: "subagentStop",
  Notification: "notification",
  SessionEnd: "sessionEnd",
};
const TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse"]);

export type ClaudePluginTranslation = { manifest: PluginManifest; warnings: string[] };

type Confined = { rel: string; abs: string };

/**
 * A manifest-relative path, confined to the plugin root; undefined when absent
 * or unsafe. Absence is only worth a warning for a path the manifest named.
 */
function confinedPath(
  root: string,
  value: string,
  warnings: string[],
  what: string,
  optional: boolean,
): Confined | undefined {
  const cleaned = value.trim();
  if (cleaned === "" || isAbsolute(cleaned)) {
    warnings.push(`${what} path "${value}" must be relative to the plugin`);
    return undefined;
  }
  const abs = resolve(root, cleaned);
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    warnings.push(`${what} path "${value}" leaves the plugin directory`);
    return undefined;
  }
  let physical: string;
  try {
    physical = realpathSync(abs);
  } catch {
    if (!optional) warnings.push(`${what} path "${value}" was not found`);
    return undefined;
  }
  if (!physical.startsWith(`${root}${sep}`)) {
    warnings.push(`${what} path "${value}" leaves the plugin directory`);
    return undefined;
  }
  return { rel, abs: physical };
}

function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path: string): unknown {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("must be a regular file");
  return JSON.parse(readUtf8FileBoundedSync(path, MAX_COMPONENT_FILE_BYTES));
}

function asList(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** Directory roots for one component: the default dir, then (adding or replacing) the manifest's. */
function componentRoots(
  root: string,
  defaults: string,
  declared: string | string[] | undefined,
  mode: "adds" | "replaces",
  what: string,
  warnings: string[],
): string[] {
  const out: string[] = [];
  const push = (value: string, optional: boolean): void => {
    const confined = confinedPath(root, value, warnings, what, optional);
    if (!confined) return;
    if (!isDirectory(confined.abs)) {
      if (!optional) warnings.push(`${what} path "${value}" is not a directory; only directories are supported`);
      return;
    }
    if (!out.includes(confined.rel)) out.push(confined.rel);
  };
  if (declared === undefined || mode === "adds") push(defaults, true);
  for (const value of asList(declared)) push(value, false);
  return out;
}

/** Quote a path for a POSIX shell, so a hook can use `${CLAUDE_PLUGIN_ROOT}` unchanged. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function substituteRoot(value: string, root: string): string {
  return value.replace(PLUGIN_ROOT_VAR, root);
}

/**
 * Component objects (hooks / MCP / LSP) come from a default file, manifest
 * path(s), or an inline object. Each yields one raw object per source.
 */
function componentObjects(
  root: string,
  defaults: string,
  declared: string | string[] | Record<string, unknown> | undefined,
  what: string,
  warnings: string[],
): Array<{ label: string; value: unknown }> {
  const out: Array<{ label: string; value: unknown }> = [];
  const load = (value: string, optional: boolean): void => {
    const confined = confinedPath(root, value, warnings, what, optional);
    if (!confined) return;
    try {
      out.push({ label: value, value: readJson(confined.abs) });
    } catch (error) {
      warnings.push(`${what} file "${value}" is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (declared === undefined) {
    load(defaults, true);
  } else if (typeof declared === "string" || Array.isArray(declared)) {
    for (const value of asList(declared)) load(value, false);
  } else {
    out.push({ label: "plugin.json", value: declared });
  }
  return out;
}

function translateHooks(
  sources: Array<{ label: string; value: unknown }>,
  root: string,
  warnings: string[],
): HookConfig {
  const hooks: HookConfig = {};
  const prefix = `export CLAUDE_PLUGIN_ROOT=${shellQuote(root)}; `;
  let translated = 0;
  for (const source of sources) {
    // A plugin.json `hooks` object may be the events map itself or wrap it.
    const candidate =
      typeof source.value === "object" && source.value !== null && !("hooks" in source.value)
        ? { hooks: source.value }
        : source.value;
    const parsed = hooksFileSchema.safeParse(candidate);
    if (!parsed.success) {
      warnings.push(`hooks in ${source.label} are not in Claude Code's hooks.json shape`);
      continue;
    }
    for (const [event, groups] of Object.entries(parsed.data.hooks)) {
      const stage = HOOK_EVENTS[event];
      if (!stage) {
        warnings.push(`hook event ${event} is not supported and was skipped`);
        continue;
      }
      for (const group of groups) {
        let tools: string[] | undefined = ["*"];
        if (TOOL_EVENTS.has(event)) {
          tools = hookMatcherTools(group.matcher);
        } else if (group.matcher !== undefined && group.matcher !== "" && group.matcher !== "*") {
          tools = undefined;
        }
        if (!tools) {
          warnings.push(`${event} hook matcher "${group.matcher}" cannot be translated; those hooks were skipped`);
          continue;
        }
        for (const handler of group.hooks) {
          if (handler.type !== "command" || typeof handler.command !== "string" || handler.command.trim() === "") {
            warnings.push(`${event} hook of type "${handler.type}" is not supported and was skipped`);
            continue;
          }
          const command = `${prefix}${handler.command}`;
          const entries: HookEntry[] = TOOL_EVENTS.has(event)
            ? tools.map((tool) => (tool === "*" ? { command } : { match: tool, command }))
            : [{ command }];
          hooks[stage] = [...(hooks[stage] ?? []), ...entries];
          translated++;
        }
      }
    }
  }
  if (translated > 0) {
    warnings.push(
      "hook commands receive SeekForge's hook payload and exit-code contract (any non-zero exit blocks a preToolUse hook), not Claude Code's",
    );
  }
  return hooks;
}

function serverName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

const mcpEntrySchema = z
  .object({
    type: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

function translateMcp(
  sources: Array<{ label: string; value: unknown }>,
  root: string,
  warnings: string[],
): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const source of sources) {
    const value = source.value as Record<string, unknown> | null;
    const map =
      typeof value === "object" && value !== null && typeof value.mcpServers === "object" && value.mcpServers !== null
        ? (value.mcpServers as Record<string, unknown>)
        : value;
    if (typeof map !== "object" || map === null || Array.isArray(map)) {
      warnings.push(`MCP servers in ${source.label} are not an object`);
      continue;
    }
    for (const [rawName, rawEntry] of Object.entries(map)) {
      const name = serverName(rawName);
      const parsed = mcpEntrySchema.safeParse(rawEntry);
      const entry = parsed.success ? parsed.data : undefined;
      const command = entry?.command?.trim();
      const url = entry?.url?.trim();
      if (!entry || name === "" || !NAME_RE.test(name) || Boolean(command) === Boolean(url)) {
        warnings.push(`MCP server "${rawName}" needs a valid name and exactly one of command or url; skipped`);
        continue;
      }
      if (entry.type !== undefined && !["stdio", "http", "streamable-http"].includes(entry.type)) {
        warnings.push(`MCP server "${rawName}" uses transport ${entry.type}, which is not supported; skipped`);
        continue;
      }
      if (servers[name]) {
        warnings.push(`MCP server "${rawName}" collides with another server named ${name}; skipped`);
        continue;
      }
      const env = entry.env
        ? Object.fromEntries(Object.entries(entry.env).map(([key, val]) => [key, substituteRoot(val, root)]))
        : undefined;
      servers[name] = {
        ...(command ? { command: substituteRoot(command, root) } : {}),
        ...(entry.args ? { args: entry.args.map((arg) => substituteRoot(arg, root)) } : {}),
        ...(env ? { env } : {}),
        ...(url ? { url } : {}),
        ...(entry.headers ? { headers: { ...entry.headers } } : {}),
        // Claude Code starts a plugin's servers once the plugin is enabled;
        // here that enablement is the approval of this exact digest.
        trusted: true,
      };
    }
  }
  return servers;
}

function translateLsp(
  sources: Array<{ label: string; value: unknown }>,
  root: string,
  warnings: string[],
): Record<string, LspServerConfig> {
  const servers: Record<string, LspServerConfig> = {};
  for (const source of sources) {
    if (typeof source.value !== "object" || source.value === null || Array.isArray(source.value)) {
      warnings.push(`language servers in ${source.label} are not an object`);
      continue;
    }
    for (const [name, raw] of Object.entries(source.value as Record<string, unknown>)) {
      const parsed = parseLspServerConfig(raw);
      if (!parsed.config || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        warnings.push(`language server "${name}" is invalid (${parsed.error ?? "bad name"}); skipped`);
        continue;
      }
      const config = parsed.config;
      servers[name] = {
        ...config,
        command: substituteRoot(config.command, root),
        ...(config.args ? { args: config.args.map((arg) => substituteRoot(arg, root)) } : {}),
        ...(config.env
          ? {
              env: Object.fromEntries(Object.entries(config.env).map(([key, val]) => [key, substituteRoot(val, root)])),
            }
          : {}),
      };
    }
  }
  return servers;
}

/** Flat `agents/<name>.md` files are Claude Code's agent layout, which the agent loader does not read. */
function flatAgentFiles(root: string, rel: string): boolean {
  try {
    return readdirSync(join(root, rel), { withFileTypes: true }).some(
      (entry) => entry.isFile() && entry.name.endsWith(".md"),
    );
  } catch {
    return false;
  }
}

/**
 * Translate `<root>/.claude-plugin/plugin.json`. `root` must already be the
 * physical plugin directory. Throws only when the manifest itself is unusable.
 */
export function translateClaudePlugin(root: string, raw: unknown): ClaudePluginTranslation {
  const parsed = claudeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `invalid .claude-plugin/plugin.json: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid manifest"}`,
    );
  }
  const data = parsed.data;
  const warnings: string[] = [];
  let version = data.version ?? "0.0.0";
  if (!SEMVER_RE.test(version)) {
    warnings.push(`version "${data.version}" is not semver; shown as 0.0.0`);
    version = "0.0.0";
  }
  const skillRoots = componentRoots(root, "skills", data.skills, "adds", "skills", warnings);
  const agentRoots = componentRoots(root, "agents", data.agents, "replaces", "agents", warnings);
  const commandRoots = componentRoots(root, "commands", data.commands, "replaces", "commands", warnings);
  const outputStyleRoots = componentRoots(
    root,
    "output-styles",
    data.outputStyles,
    "replaces",
    "outputStyles",
    warnings,
  );
  for (const rel of agentRoots) {
    if (flatAgentFiles(root, rel)) {
      warnings.push(`agents in ${rel}/*.md use Claude Code's flat layout, which SeekForge does not load yet`);
    }
  }
  const hooks = translateHooks(
    componentObjects(root, join("hooks", "hooks.json"), data.hooks, "hooks", warnings),
    root,
    warnings,
  );
  const mcpServers = translateMcp(
    componentObjects(root, ".mcp.json", data.mcpServers, "mcpServers", warnings),
    root,
    warnings,
  );
  const lspServers = translateLsp(
    componentObjects(root, ".lsp.json", data.lspServers, "lspServers", warnings),
    root,
    warnings,
  );
  const contributes: NonNullable<PluginManifest["contributes"]> = {
    ...(skillRoots.length > 0 ? { skillRoots } : {}),
    ...(agentRoots.length > 0 ? { agentRoots } : {}),
    ...(commandRoots.length > 0 ? { commandRoots } : {}),
    ...(outputStyleRoots.length > 0 ? { outputStyleRoots } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(lspServers).length > 0 ? { lspServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
  };
  return {
    manifest: {
      apiVersion: PLUGIN_API_VERSION,
      id: data.name,
      name: data.name,
      version,
      ...(data.description !== undefined ? { description: data.description.slice(0, 2_000) } : {}),
      ...(Object.keys(contributes).length > 0 ? { contributes } : {}),
    },
    warnings,
  };
}
