// Pure helpers for `mcp add` / `mcp remove` / `mcp import`: mutate the
// mcpServers map in a .seekforge config document without losing other keys, and
// read other tools' server definitions. Kept separate from the commands so the
// logic is unit-testable.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { McpDefinitionError, type McpServerConfig, parseMcpServerDefinition } from "@seekforge/core";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { writeStatePath } from "./project-state.js";

type ConfigDoc = { mcpServers?: Record<string, McpServerConfig>; [k: string]: unknown };

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Where an `mcp` command writes:
 * - `user` — `~/.seekforge/config.json`, every project, the only scope that can
 *   carry `trusted: true`;
 * - `project` — `<cwd>/.seekforge/config.json`, shared with the repository;
 * - `local` — `<cwd>/.seekforge/config.local.json`, this checkout only.
 * Both project scopes are repository layers: their servers connect only once
 * approved for the workspace.
 */
export type McpScope = "user" | "project" | "local";

/** Resolve the config.json path: project .seekforge/ or global ~/.seekforge/. */
export function mcpConfigPath(projectPath: string, global: boolean): string {
  const base = global ? homedir() : projectPath;
  return join(base, ".seekforge", "config.json");
}

export function mcpScopePath(projectPath: string, scope: McpScope): string {
  if (scope === "local") return join(projectPath, ".seekforge", "config.local.json");
  return mcpConfigPath(projectPath, scope === "user");
}

/** `--scope` wins; `-g/--global` is the older spelling of `--scope user`. Default `project`. */
export function resolveMcpScope(opts: { scope?: string; global?: boolean }): McpScope {
  const { scope, global } = opts;
  if (scope !== undefined && scope !== "user" && scope !== "project" && scope !== "local") {
    throw new McpDefinitionError('--scope must be "user", "project" or "local"');
  }
  if (global && scope !== undefined && scope !== "user") {
    throw new McpDefinitionError(`--global conflicts with --scope ${scope}`);
  }
  return scope ?? (global ? "user" : "project");
}

/**
 * Returns a new config document with `name` added to mcpServers. Throws if a
 * server with that name already exists (callers can offer --force later) or if
 * the command is empty. Pure — does not touch disk.
 */
export function addMcpServer(doc: ConfigDoc, name: string, command: string, args: string[]): ConfigDoc {
  if (!command.trim()) throw new Error("command must not be empty");
  return addMcpServerEntry(doc, name, { command, ...(args.length > 0 ? { args } : {}) });
}

/** addMcpServer for any already-validated definition. Pure. */
export function addMcpServerEntry(doc: ConfigDoc, name: string, entry: McpServerConfig): ConfigDoc {
  if (!name.trim()) throw new Error("server name must not be empty");
  const servers = isObjectRecord(doc.mcpServers) ? doc.mcpServers : {};
  if (Object.hasOwn(servers, name)) throw new Error(`MCP server "${name}" already exists (remove it first)`);
  return { ...doc, mcpServers: { ...servers, [name]: entry } };
}

/** What `mcp add` was given on the command line, before validation. */
export type McpAddInput = {
  transport: "stdio" | "http" | "sse";
  /** stdio: command then args; http/sse: exactly the url. */
  target: string[];
  env: Array<[string, string]>;
  headers: Array<[string, string]>;
  trusted?: boolean;
};

/**
 * Turns `mcp add` input into a validated definition. `type` is written only
 * for `sse`, the one transport a bare definition cannot imply.
 */
export function mcpAddDefinition(input: McpAddInput): McpServerConfig {
  const { transport, target, env, headers } = input;
  if (transport === "stdio") {
    if (headers.length > 0) throw new McpDefinitionError("--header applies to http and sse servers");
  } else {
    if (env.length > 0) throw new McpDefinitionError("--env applies to stdio servers");
    if (target.length !== 1) {
      throw new McpDefinitionError(`an ${transport} server takes exactly one url after the name`);
    }
  }
  const [first, ...rest] = target;
  const raw: Record<string, unknown> =
    transport === "stdio"
      ? {
          command: first ?? "",
          ...(rest.length > 0 ? { args: rest } : {}),
          ...(env.length > 0 ? { env: Object.fromEntries(env) } : {}),
        }
      : {
          ...(transport === "sse" ? { type: "sse" } : {}),
          url: first ?? "",
          ...(headers.length > 0 ? { headers: Object.fromEntries(headers) } : {}),
        };
  if (input.trusted) raw.trusted = true;
  return parseMcpServerDefinition(raw).config;
}

export type McpImportSource = "claude-desktop" | "claude-code";

/** One definition found in another tool's config, ready to write. */
export type McpImportCandidate = {
  name: string;
  config: McpServerConfig;
  /** Human-readable origin, e.g. "claude-code (project /path)". */
  source: string;
  /** Fields of the original entry this format has no place for. */
  dropped: string[];
};

export type McpImportProblem = { name: string; source: string; reason: string };

export type McpImportEnvironment = {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  projectPath: string;
  /** Reads a file as text; returns undefined when it does not exist. */
  readText: (path: string) => string | undefined;
};

/** Where Claude Desktop keeps its config on this platform, most likely first. */
export function claudeDesktopConfigPaths(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const file = "claude_desktop_config.json";
  if (platform === "darwin") return [join(home, "Library", "Application Support", "Claude", file)];
  if (platform === "win32") {
    const appData = env["APPDATA"] ?? join(home, "AppData", "Roaming");
    return [join(appData, "Claude", file)];
  }
  const configHome = env["XDG_CONFIG_HOME"] ?? join(home, ".config");
  return [join(configHome, "Claude", file)];
}

function sameDirectory(a: string, b: string): boolean {
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  return canonical(a) === canonical(b);
}

/**
 * Collects importable server definitions. Claude Desktop contributes its
 * `mcpServers`; Claude Code's `~/.claude.json` contributes its user-scope
 * `mcpServers` and the entries it keeps for THIS project under `projects`.
 * A name seen twice keeps its first definition. Nothing is written.
 */
export function collectMcpImportCandidates(
  from: McpImportSource | undefined,
  environment: McpImportEnvironment,
): { candidates: McpImportCandidate[]; problems: McpImportProblem[]; scanned: string[] } {
  const candidates: McpImportCandidate[] = [];
  const problems: McpImportProblem[] = [];
  const scanned: string[] = [];
  const seen = new Set<string>();

  const readJson = (path: string): Record<string, unknown> | undefined => {
    const text = environment.readText(path);
    if (text === undefined) return undefined;
    scanned.push(path);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isObjectRecord(parsed)) return parsed;
    } catch {
      // reported below
    }
    problems.push({ name: "*", source: path, reason: "not a JSON object" });
    return undefined;
  };

  const take = (servers: unknown, source: string): void => {
    if (!isObjectRecord(servers)) return;
    for (const [name, value] of Object.entries(servers)) {
      if (seen.has(name)) {
        problems.push({ name, source, reason: "a server with this name was already found in another source" });
        continue;
      }
      try {
        const entry = isObjectRecord(value) ? { ...value } : value;
        const dropped: string[] = [];
        // Claude Code's `oauth` ({ clientId, callbackPort }) describes its own
        // interactive flow, not a refresh-token grant; `seekforge mcp login`
        // covers that case.
        if (isObjectRecord(entry) && isObjectRecord(entry.oauth) && typeof entry.oauth.tokenEndpoint !== "string") {
          delete entry.oauth;
          dropped.push("oauth");
        }
        // Trust is decided by this import, not carried over from another file.
        if (isObjectRecord(entry)) delete entry.trusted;
        const parsed = parseMcpServerDefinition(entry, { unknownFields: "drop" });
        candidates.push({ name, config: parsed.config, source, dropped: [...dropped, ...parsed.dropped] });
        seen.add(name);
      } catch (error) {
        problems.push({ name, source, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  if (from === undefined || from === "claude-desktop") {
    for (const path of claudeDesktopConfigPaths(environment.home, environment.platform, environment.env)) {
      const doc = readJson(path);
      if (doc) take(doc.mcpServers, "claude-desktop");
    }
  }
  if (from === undefined || from === "claude-code") {
    const doc = readJson(join(environment.home, ".claude.json"));
    if (doc) {
      take(doc.mcpServers, "claude-code (user)");
      if (isObjectRecord(doc.projects)) {
        for (const [projectPath, project] of Object.entries(doc.projects)) {
          if (!isObjectRecord(project) || !sameDirectory(projectPath, environment.projectPath)) continue;
          take(project.mcpServers, `claude-code (project ${projectPath})`);
        }
      }
    }
  }
  return { candidates, problems, scanned };
}

/**
 * Returns a new config document with `name` removed from mcpServers. Throws if
 * the server is not present. Pure.
 */
export function removeMcpServer(doc: ConfigDoc, name: string): ConfigDoc {
  const servers = doc.mcpServers ?? {};
  if (!servers[name]) throw new Error(`MCP server "${name}" not found`);
  const next = { ...servers };
  delete next[name];
  const out: ConfigDoc = { ...doc, mcpServers: next };
  if (Object.keys(next).length === 0) delete out.mcpServers;
  return out;
}

/**
 * Thrown when a config.json EXISTS but cannot be used as a config object
 * (syntactically invalid JSON, a non-object root, or otherwise unreadable).
 * Callers surface this and refuse to write, rather than silently replacing a
 * config they couldn't parse — which would drop apiKey/permissionRules/hooks/…
 */
export class ConfigParseError extends Error {
  constructor(public readonly path: string) {
    super(`config file exists but is not a valid JSON object: ${path}`);
    this.name = "ConfigParseError";
  }
}

/**
 * Read a config.json document. A MISSING file yields an empty doc ({}); a file
 * that exists but can't be parsed as a JSON object throws {@link ConfigParseError}
 * so callers abort rather than clobber it (mirrors `config set`'s behavior).
 */
export function readConfigDoc(path: string): ConfigDoc {
  let raw: string;
  try {
    raw = readTextFileBounded(path, MAX_CONFIG_FILE_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Exists but unreadable (EACCES, EISDIR, …): don't risk overwriting it.
    throw new ConfigParseError(path);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigParseError(path);
  }
  if (!isObjectRecord(parsed)) throw new ConfigParseError(path);
  return parsed as ConfigDoc;
}

/** Extract --mcp-config servers from either {mcpServers:{...}} or a bare map. */
export function extractMcpServersDoc(parsed: unknown): Record<string, unknown> | null {
  if (!isObjectRecord(parsed)) return null;
  const candidate = parsed.mcpServers === undefined ? parsed : parsed.mcpServers;
  return isObjectRecord(candidate) ? candidate : null;
}

/** Write a config.json document, creating .seekforge/ as needed (2-space JSON). */
export function writeConfigDoc(path: string, doc: ConfigDoc): void {
  writeStatePath(path, `${JSON.stringify(doc, null, 2)}\n`);
}
