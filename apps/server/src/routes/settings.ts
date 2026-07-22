/**
 * Settings-flavored routes: custom commands + output styles, the cross-session
 * todo list, account balance, MCP server config/introspection, the doctor
 * panel, and the config/hooks editors.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  acquireSessionLease,
  acquireWorkspaceSessionGuard,
  createMcpClient,
  expandShellInjections,
  expandUserCommand,
  fetchBalance,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  listOutputStyles,
  loadUserCommands,
  MODEL_PRICING,
  resolveProviderPreset,
  verifyDeepSeekAccess,
  SessionBusyError,
  type HookConfig,
  type HookEntry,
  type McpClientEntry,
  type McpServerConfig,
} from "@seekforge/core";
import { loadConfig, maskedConfig, readProjectFile, setConfigValue, writeProjectFileAtomic } from "../config.js";
import { readFileBounded } from "@seekforge/shared/bounded-file-read";
import { MAX_CONFIG_FILE_BYTES } from "@seekforge/shared/config-layers";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { runShellCommand } from "../shell-command.js";
import { addTodo, loadTodos, removeTodo, toggleTodo } from "@seekforge/shared/todos";
import type { RouteCtx } from "./context.js";

const execFileAsync = promisify(execFile);

type ConfigDoc = { mcpServers?: Record<string, McpServerConfig>; [k: string]: unknown };

type McpScope = "global" | "project";

const MASKED_SECRET = "********";
const GLOBAL_CONFIG_LOCK_ID = "coord-server-global-config";

class ConfigMutationError extends Error {}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseConfigDoc(raw: string): ConfigDoc {
  const parsed = JSON.parse(raw) as unknown;
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ConfigDoc) : {};
}

/**
 * Read-merge-write the workspace .seekforge/config.json mcpServers map: applies
 * `mutate` to the current servers object and writes the file back (mode 0o600).
 * Other top-level keys are preserved; an empty mcpServers map is dropped.
 */
function mutateMcpServers<T>(
  workspace: string,
  scope: McpScope,
  mutate: (servers: Record<string, McpServerConfig>) => T,
): T {
  const doc = readConfigDoc(workspace, scope, true);
  const servers = { ...(doc.mcpServers ?? {}) };
  const result = mutate(servers);
  if (Object.keys(servers).length === 0) delete doc.mcpServers;
  else doc.mcpServers = servers;
  writeConfigDoc(workspace, scope, doc);
  return result;
}

async function withSettingsMutation<T>(
  rest: RouteCtx["rest"],
  workspace: string,
  scope: McpScope,
  operation: () => T,
): Promise<T> {
  if (scope === "global") {
    const lease = acquireSessionLease(homedir(), GLOBAL_CONFIG_LOCK_ID);
    try {
      return operation();
    } finally {
      lease.release();
    }
  }
  return rest.coordinator.withRepository(workspace, async () => {
    const guard = acquireWorkspaceSessionGuard(workspace);
    try {
      return operation();
    } finally {
      guard.release();
    }
  });
}

function settingsBusy(res: RouteCtx["res"], error: unknown): boolean {
  if (!(error instanceof SessionBusyError)) return false;
  sendApiError(res, 409, "session_busy", "cannot mutate settings while the selected scope is active");
  return true;
}

/** Reads one config layer (raw); returns {} on missing/invalid. */
function readConfigDoc(workspace: string, scope: McpScope = "project", strict = false): ConfigDoc {
  try {
    const raw =
      scope === "project"
        ? readProjectFile(workspace, ".seekforge/config.json", MAX_CONFIG_FILE_BYTES)
        : readFileBounded(join(homedir(), ".seekforge", "config.json"), MAX_CONFIG_FILE_BYTES).toString("utf8");
    return raw === undefined ? {} : parseConfigDoc(raw);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

function writeConfigDoc(workspace: string, scope: McpScope, doc: ConfigDoc): void {
  const serialized = `${JSON.stringify(doc, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_FILE_BYTES) {
    throw new ConfigMutationError(`config exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
  }
  if (scope === "project") {
    writeProjectFileAtomic(workspace, ".seekforge/config.json", serialized);
    return;
  }
  const target = join(homedir(), ".seekforge", "config.json");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error("global config must not be a symbolic link");
  }
  const temp = join(dirname(target), `.config-${randomBytes(12).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, serialized, { flag: "wx", mode: 0o600 });
    renameSync(temp, target);
    chmodSync(target, 0o600);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // rename consumed the temporary file, or creation failed
    }
  }
}

function mcpServersAt(workspace: string, scope: McpScope): Record<string, McpServerConfig> {
  const servers = readConfigDoc(workspace, scope).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
  return Object.fromEntries(Object.entries(servers).filter((entry) => isMcpServerConfig(entry[1])));
}

function maskedMap(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.keys(values ?? {})
      .sort()
      .map((key) => [key, MASKED_SECRET]),
  );
}

function preserveMaskedValues(
  incoming: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (incoming === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === MASKED_SECRET && previous?.[key] !== undefined) result[key] = previous[key];
    else result[key] = value;
  }
  return result;
}

function sanitizedOauth(oauth: McpServerConfig["oauth"]): Record<string, string> | undefined {
  if (!oauth) return undefined;
  return {
    tokenEndpoint: oauth.tokenEndpoint,
    clientId: oauth.clientId,
    refreshToken: MASKED_SECRET,
    ...(oauth.clientSecret !== undefined ? { clientSecret: MASKED_SECRET } : {}),
    ...(oauth.scope !== undefined ? { scope: oauth.scope } : {}),
  };
}

function sanitizedMcpServer(name: string, cfg: McpServerConfig, source: McpScope, shadowedGlobal = false) {
  return {
    name,
    transport: cfg.url ? ("http" as const) : ("stdio" as const),
    ...(cfg.command ? { command: cfg.command } : {}),
    args: cfg.args ?? [],
    ...(cfg.url ? { url: cfg.url } : {}),
    env: maskedMap(cfg.env),
    headers: maskedMap(cfg.headers),
    ...(cfg.oauth ? { oauth: sanitizedOauth(cfg.oauth) } : {}),
    trusted: cfg.trusted === true,
    source,
    shadowedGlobal,
  };
}

const HOOK_STAGES = [
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

/** Validates a hooks object from PUT /api/hooks into a clean HookConfig. */
function validateHooks(input: unknown): { hooks: HookConfig } | { error: string } {
  if (input === null || typeof input !== "object") return { error: "hooks must be an object" };
  const out: HookConfig = {};
  for (const [stage, entries] of Object.entries(input as Record<string, unknown>)) {
    if (!(HOOK_STAGES as readonly string[]).includes(stage)) {
      return { error: `unknown hook stage: ${stage}` };
    }
    if (!Array.isArray(entries)) return { error: `${stage} must be an array` };
    const list: HookEntry[] = [];
    for (const e of entries) {
      if (e === null || typeof e !== "object") return { error: `${stage} entries must be objects` };
      const { command, match, pattern } = e as Record<string, unknown>;
      if (typeof command !== "string" || command.trim() === "") {
        return { error: `${stage} entry needs a non-empty command` };
      }
      if (match !== undefined && typeof match !== "string") return { error: `${stage} match must be a string` };
      if (pattern !== undefined && typeof pattern !== "string") return { error: `${stage} pattern must be a string` };
      list.push({
        command,
        ...(match !== undefined && match !== "" ? { match } : {}),
        ...(pattern !== undefined && pattern !== "" ? { pattern } : {}),
      });
    }
    if (list.length > 0) out[stage as keyof HookConfig] = list;
  }
  return { hooks: out };
}

/** Writes the hooks block into the project config.json, preserving other keys. */
function writeHooks(workspace: string, hooks: HookConfig): void {
  const doc = readConfigDoc(workspace, "project", true);
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  else doc.hooks = hooks;
  writeProjectFileAtomic(workspace, ".seekforge/config.json", `${JSON.stringify(doc, null, 2)}\n`);
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace, rest }: RouteCtx): Promise<void> {
  const path = url.pathname;

  // Custom user-defined slash commands (project + user layers; project wins).
  if (method === "GET" && path === "/api/commands") {
    return sendJson(res, 200, { commands: loadUserCommands(workspace) });
  }

  // Output styles: built-ins + custom .seekforge/output-styles/*.md files.
  if (method === "GET" && path === "/api/output-styles") {
    return sendJson(res, 200, { styles: listOutputStyles(workspace) });
  }

  // Expand a custom command server-side: interpolate args ($ARGUMENTS / $1..$9)
  // and run any !`shell` injections in the workspace, returning the final text.
  if (method === "POST" && path === "/api/commands/expand") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { name, args } = (body ?? {}) as { name?: unknown; args?: unknown };
    if (typeof name !== "string" || name === "") {
      return sendApiError(res, 400, "bad_request", "name must be a non-empty string");
    }
    const command = loadUserCommands(workspace).find((c) => c.name === name);
    if (!command) {
      return sendApiError(res, 404, "not_found", `unknown command: ${name}`);
    }
    const expanded = expandUserCommand(command, typeof args === "string" ? args : "");
    try {
      const text = await rest.coordinator.withRepository(workspace, async () => {
        const guard = acquireWorkspaceSessionGuard(workspace);
        try {
          return await expandShellInjections(expanded, (cmd) => runShellCommand(cmd, workspace));
        } finally {
          guard.release();
        }
      });
      return sendJson(res, 200, { text });
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      return sendApiError(res, 409, "session_busy", "cannot run command expansions while the workspace is active");
    }
  }

  // Cross-session todo list (.seekforge/todos.md, TUI-compatible format).
  if (method === "GET" && path === "/api/todos") {
    return sendJson(res, 200, loadTodos(workspace));
  }

  if (method === "POST" && path === "/api/todos") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { op, text, index } = (body ?? {}) as { op?: unknown; text?: unknown; index?: unknown };
    if (op !== "add" && op !== "toggle" && op !== "remove") {
      return sendApiError(res, 400, "bad_request", 'op must be "add", "toggle" or "remove"');
    }
    if (op === "add" && (typeof text !== "string" || text.trim() === "")) {
      return sendApiError(res, 400, "bad_request", 'op "add" needs a non-empty text');
    }
    if (op !== "add" && (typeof index !== "number" || !Number.isInteger(index))) {
      return sendApiError(res, 400, "bad_request", `op "${op}" needs an integer index (1-based)`);
    }
    try {
      const todos = await rest.coordinator.withRepository(workspace, async () => {
        const guard = acquireWorkspaceSessionGuard(workspace);
        try {
          if (op === "add") addTodo(workspace, (text as string).trim());
          else {
            const result =
              op === "toggle" ? toggleTodo(workspace, index as number) : removeTodo(workspace, index as number);
            if (result === null) return null;
          }
          return loadTodos(workspace);
        } finally {
          guard.release();
        }
      });
      if (todos === null) return sendApiError(res, 404, "not_found", `no todo at index ${index}`);
      return sendJson(res, 200, todos);
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      return sendApiError(res, 409, "session_busy", "cannot mutate todos while the workspace is active");
    }
  }

  // DeepSeek account balance via the server's key. Null-safe by contract:
  // missing key or any fetch failure -> {balance: null}, never an error.
  // Gated on the provider's `balance` capability: a provider without a
  // /user/balance endpoint (e.g. Ark) returns null without any fetch, so its
  // key is never sent to DeepSeek's balance endpoint.
  if (method === "GET" && path === "/api/balance") {
    const config = loadConfig(workspace);
    const preset = resolveProviderPreset((config.provider ?? "deepseek").toLowerCase());
    const balanceSupported = preset?.capabilities.balance !== false;
    const balance = balanceSupported && config.apiKey ? await fetchBalance(config.apiKey, config.baseUrl) : null;
    return sendJson(res, 200, { balance });
  }

  // First-run credential check. This uses the non-billable balance endpoint
  // and never persists or echoes the submitted secret.
  if (method === "POST" && path === "/api/provider/verify") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const apiKey = body !== null && typeof body === "object" ? (body as { apiKey?: unknown }).apiKey : undefined;
    if (typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.length > 512) {
      return sendApiError(res, 400, "bad_request", "apiKey must be a string from 8 to 512 characters");
    }
    const config = loadConfig(workspace);
    return sendJson(res, 200, await verifyDeepSeekAccess(apiKey.trim(), config.baseUrl));
  }

  // Resources of every configured MCP server (resources/list), spawned on
  // demand like POST /api/mcp/:name/tools. A server that fails or lacks
  // resource support contributes zero entries (listMcpResources never throws).
  if (method === "GET" && path === "/api/mcp/resources") {
    const servers = Object.entries(loadConfig(workspace).mcpServers ?? {}).filter(
      (entry) => isMcpServerConfig(entry[1]) && entry[1].trusted === true,
    );
    const entries: McpClientEntry[] = servers.map(([serverName, config]) => ({
      serverName,
      client: createMcpClient({ name: serverName, config, workspaceRoots: [workspace] }),
      trusted: config.trusted === true,
    }));
    try {
      return sendJson(res, 200, { resources: await listMcpResources(entries) });
    } finally {
      for (const e of entries) e.client.dispose();
    }
  }

  // Prompts of every configured MCP server (prompts/list), spawned on
  // demand. Mirrors /api/mcp/resources: a server that fails or lacks prompt
  // support contributes zero entries (listMcpPrompts never throws).
  if (method === "GET" && path === "/api/mcp/prompts") {
    const servers = Object.entries(loadConfig(workspace).mcpServers ?? {}).filter(
      (entry) => isMcpServerConfig(entry[1]) && entry[1].trusted === true,
    );
    const entries: McpClientEntry[] = servers.map(([serverName, config]) => ({
      serverName,
      client: createMcpClient({ name: serverName, config, workspaceRoots: [workspace] }),
      trusted: config.trusted === true,
    }));
    try {
      return sendJson(res, 200, { prompts: await listMcpPrompts(entries) });
    } finally {
      for (const e of entries) e.client.dispose();
    }
  }

  if (method === "POST" && segs.length === 5 && segs[1] === "mcp" && segs[2] === "prompts") {
    const serverName = segs[3]!;
    const promptName = segs[4]!;
    const config = loadConfig(workspace).mcpServers?.[serverName];
    if (!isMcpServerConfig(config))
      return sendApiError(res, 404, "not_found", `MCP server not configured: ${serverName}`);
    if (config.trusted !== true) {
      return sendApiError(res, 403, "forbidden", `MCP server is not trusted: ${serverName}`);
    }
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return sendApiError(res, 400, "bad_request", "body must be an object");
    }
    const rawArgs = (body as { arguments?: unknown }).arguments;
    if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
      return sendApiError(res, 400, "bad_request", "arguments must be an object when present");
    }
    if (
      rawArgs !== undefined &&
      Object.values(rawArgs as Record<string, unknown>).some((value) => typeof value !== "string")
    ) {
      return sendApiError(res, 400, "bad_request", "argument values must be strings");
    }
    const client = createMcpClient({ name: serverName, config, workspaceRoots: [workspace] });
    const entries: McpClientEntry[] = [{ serverName, client, trusted: config.trusted === true }];
    try {
      const text = await getMcpPrompt(serverName, promptName, rawArgs as Record<string, unknown> | undefined, entries);
      return sendJson(res, 200, { text });
    } catch (err) {
      return sendApiError(res, 502, "mcp_error", err instanceof Error ? err.message : String(err));
    } finally {
      client.dispose();
    }
  }

  if (method === "GET" && path === "/api/mcp") {
    // Configured servers only — never spawned here. Project entries shadow
    // same-name global entries; secret values are represented by a sentinel
    // that POST understands as "keep the existing value".
    const globalServers = mcpServersAt(workspace, "global");
    const projectServers = mcpServersAt(workspace, "project");
    const names = [...new Set([...Object.keys(globalServers), ...Object.keys(projectServers)])].sort();
    return sendJson(
      res,
      200,
      names.map((name) =>
        projectServers[name]
          ? sanitizedMcpServer(name, projectServers[name], "project", globalServers[name] !== undefined)
          : sanitizedMcpServer(name, globalServers[name]!, "global"),
      ),
    );
  }

  // Add or update an MCP server in the workspace config.json.
  if (method === "POST" && path === "/api/mcp") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const {
      name,
      scope: rawScope,
      command,
      args,
      env,
      url: serverUrl,
      headers,
      oauth,
      trusted,
    } = (body ?? {}) as {
      name?: unknown;
      scope?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      url?: unknown;
      headers?: unknown;
      oauth?: unknown;
      trusted?: unknown;
    };
    if (typeof name !== "string" || name.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must include a non-empty name");
    }
    if (rawScope !== undefined && rawScope !== "global" && rawScope !== "project") {
      return sendApiError(res, 400, "bad_request", 'scope must be "global" or "project"');
    }
    const scope: McpScope = rawScope === "global" ? "global" : "project";
    const normalizedName = name.trim();
    if (command !== undefined && typeof command !== "string") {
      return sendApiError(res, 400, "bad_request", "command must be a string");
    }
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
      return sendApiError(res, 400, "bad_request", "args must be a string[]");
    }
    if (serverUrl !== undefined && typeof serverUrl !== "string") {
      return sendApiError(res, 400, "bad_request", "url must be a string");
    }
    if (trusted !== undefined && typeof trusted !== "boolean") {
      return sendApiError(res, 400, "bad_request", "trusted must be a boolean");
    }
    if (
      env !== undefined &&
      (typeof env !== "object" ||
        env === null ||
        Array.isArray(env) ||
        !Object.values(env as Record<string, unknown>).every((value) => typeof value === "string"))
    ) {
      return sendApiError(res, 400, "bad_request", "env must be an object with string values");
    }
    if (
      headers !== undefined &&
      (typeof headers !== "object" ||
        headers === null ||
        Array.isArray(headers) ||
        !Object.values(headers as Record<string, unknown>).every((value) => typeof value === "string"))
    ) {
      return sendApiError(res, 400, "bad_request", "headers must be an object with string values");
    }
    if (oauth !== undefined) {
      if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) {
        return sendApiError(res, 400, "bad_request", "oauth must be an object");
      }
      const value = oauth as Record<string, unknown>;
      if (
        typeof value.tokenEndpoint !== "string" ||
        value.tokenEndpoint.trim() === "" ||
        typeof value.clientId !== "string" ||
        value.clientId.trim() === "" ||
        typeof value.refreshToken !== "string" ||
        value.refreshToken === "" ||
        (value.clientSecret !== undefined && typeof value.clientSecret !== "string") ||
        (value.scope !== undefined && typeof value.scope !== "string")
      ) {
        return sendApiError(
          res,
          400,
          "bad_request",
          "oauth needs tokenEndpoint, clientId and refreshToken strings; clientSecret and scope are optional strings",
        );
      }
    }
    const hasCommand = typeof command === "string" && command.trim() !== "";
    const hasUrl = typeof serverUrl === "string" && serverUrl.trim() !== "";
    if (hasCommand === hasUrl) {
      return sendApiError(res, 400, "bad_request", "provide exactly one non-empty command (stdio) or url (HTTP)");
    }
    if (hasCommand && oauth !== undefined) {
      return sendApiError(res, 400, "bad_request", "oauth is supported only for HTTP MCP servers");
    }
    if (hasUrl) {
      try {
        const parsed = new URL(serverUrl.trim());
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
      } catch {
        return sendApiError(res, 400, "bad_request", "url must be an absolute http or https URL");
      }
    }
    try {
      const result = await withSettingsMutation(rest, workspace, scope, () =>
        mutateMcpServers(workspace, scope, (servers) => {
          const previous = servers[normalizedName];
          const nextEnv = preserveMaskedValues(env as Record<string, string> | undefined, previous?.env);
          const nextHeaders = preserveMaskedValues(headers as Record<string, string> | undefined, previous?.headers);
          let nextOauth: McpServerConfig["oauth"] | undefined;
          if (oauth !== undefined) {
            const incoming = oauth as NonNullable<McpServerConfig["oauth"]>;
            if (incoming.refreshToken === MASKED_SECRET && previous?.oauth?.refreshToken === undefined) {
              throw new ConfigMutationError("oauth refreshToken must be provided for a new server");
            }
            if (incoming.clientSecret === MASKED_SECRET && previous?.oauth?.clientSecret === undefined) {
              throw new ConfigMutationError("oauth clientSecret placeholder has no existing value");
            }
            const refreshToken =
              incoming.refreshToken === MASKED_SECRET && previous?.oauth?.refreshToken !== undefined
                ? previous.oauth.refreshToken
                : incoming.refreshToken;
            const clientSecret =
              incoming.clientSecret === MASKED_SECRET && previous?.oauth?.clientSecret !== undefined
                ? previous.oauth.clientSecret
                : incoming.clientSecret;
            nextOauth = {
              tokenEndpoint: incoming.tokenEndpoint.trim(),
              clientId: incoming.clientId.trim(),
              refreshToken,
              ...(clientSecret !== undefined && clientSecret !== "" ? { clientSecret } : {}),
              ...(incoming.scope !== undefined && incoming.scope.trim() !== "" ? { scope: incoming.scope.trim() } : {}),
            };
          }
          const entry: McpServerConfig = {
            ...(hasCommand ? { command: command.trim() } : {}),
            ...(Array.isArray(args) && args.length > 0 ? { args: args as string[] } : {}),
            ...(nextEnv !== undefined && Object.keys(nextEnv).length > 0 ? { env: nextEnv } : {}),
            ...(hasUrl ? { url: serverUrl.trim() } : {}),
            ...(nextHeaders !== undefined && Object.keys(nextHeaders).length > 0 ? { headers: nextHeaders } : {}),
            ...(nextOauth ? { oauth: nextOauth } : {}),
            ...(trusted !== undefined ? { trusted } : {}),
          };
          servers[normalizedName] = entry;
          return entry;
        }),
      );
      return sendJson(res, 200, { ok: true, server: sanitizedMcpServer(normalizedName, result, scope) });
    } catch (error) {
      if (settingsBusy(res, error)) return;
      if (error instanceof ConfigMutationError) return sendApiError(res, 400, "bad_request", error.message);
      throw error;
    }
  }

  // Remove an MCP server from the workspace config.json.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "mcp") {
    const name = segs[2]!;
    const rawScope = url.searchParams.get("scope");
    if (rawScope !== null && rawScope !== "global" && rawScope !== "project") {
      return sendApiError(res, 400, "bad_request", 'scope must be "global" or "project"');
    }
    const scope: McpScope = rawScope === "global" ? "global" : "project";
    try {
      const removed = await withSettingsMutation(rest, workspace, scope, () =>
        mutateMcpServers(workspace, scope, (servers) => {
          if (!servers[name]) return false;
          delete servers[name];
          return true;
        }),
      );
      if (!removed) return sendApiError(res, 404, "not_found", `MCP server not configured in ${scope} scope: ${name}`);
      return sendJson(res, 200, { ok: true, scope });
    } catch (error) {
      if (settingsBusy(res, error)) return;
      throw error;
    }
  }

  if (method === "POST" && segs.length === 4 && segs[1] === "mcp" && segs[3] === "test") {
    const name = segs[2]!;
    const config = loadConfig(workspace).mcpServers?.[name];
    if (!isMcpServerConfig(config)) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
    const client = createMcpClient({ name, config, workspaceRoots: [workspace] });
    const started = Date.now();
    try {
      const tools = await client.listTools();
      return sendJson(res, 200, { ok: true, latencyMs: Date.now() - started, toolCount: tools.length });
    } catch (err) {
      return sendApiError(res, 502, "mcp_error", err instanceof Error ? err.message : String(err));
    } finally {
      client.dispose();
    }
  }

  if (method === "POST" && segs.length === 4 && segs[1] === "mcp" && segs[3] === "tools") {
    const name = segs[2]!;
    const config = loadConfig(workspace).mcpServers?.[name];
    if (!isMcpServerConfig(config)) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
    const client = createMcpClient({ name, config, workspaceRoots: [workspace] });
    try {
      const tools = await client.listTools();
      return sendJson(res, 200, {
        tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return sendApiError(res, 502, "mcp_error", message);
    } finally {
      client.dispose();
    }
  }

  // Lightweight environment/health check for the desktop diagnostics panel.
  if (method === "GET" && path === "/api/doctor") {
    const config = loadConfig(workspace);
    let git: string | null = null;
    try {
      const { stdout } = await execFileAsync("git", ["--version"], { timeout: 5_000 });
      git = stdout.trim();
    } catch {
      // git not installed (ENOENT) or any failure → null
      git = null;
    }
    const runtimeBin = config.runtimeBin;
    return sendJson(res, 200, {
      apiKeyConfigured: Boolean(config.apiKey),
      nodeVersion: process.version,
      git,
      runtimeBin: {
        set: Boolean(runtimeBin),
        exists: runtimeBin ? existsSync(runtimeBin) : false,
      },
      mcpServerCount: Object.keys(config.mcpServers ?? {}).length,
      modelCount: Object.keys(MODEL_PRICING).length,
      workspace,
    });
  }

  if (method === "GET" && path === "/api/config") {
    return sendJson(res, 200, maskedConfig(workspace));
  }

  // Project hooks (the editable layer): read/write .seekforge/config.json hooks.
  if (method === "GET" && path === "/api/hooks") {
    return sendJson(res, 200, { hooks: readConfigDoc(workspace).hooks ?? {} });
  }
  if (method === "PUT" && path === "/api/hooks") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const hooksInput = body !== null && typeof body === "object" ? (body as { hooks?: unknown }).hooks : undefined;
    const result = validateHooks(hooksInput);
    if ("error" in result) {
      return sendApiError(res, 400, "bad_request", result.error);
    }
    try {
      await withSettingsMutation(rest, workspace, "project", () => writeHooks(workspace, result.hooks));
      return sendJson(res, 200, { hooks: result.hooks });
    } catch (error) {
      if (settingsBusy(res, error)) return;
      throw error;
    }
  }

  if (method === "PUT" && path === "/api/config") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { key, value, global } = (body ?? {}) as { key?: unknown; value?: unknown; global?: unknown };
    if (typeof key !== "string") {
      return sendApiError(res, 400, "bad_request", "body must be {key, value, global?}");
    }
    try {
      // ConfigValueError (unknown key / bad value) maps to 400 in the
      // trailing catch.
      await withSettingsMutation(rest, workspace, global === true ? "global" : "project", () =>
        setConfigValue(workspace, key, value, global === true),
      );
      return sendJson(res, 200, maskedConfig(workspace));
    } catch (error) {
      if (settingsBusy(res, error)) return;
      throw error;
    }
  }
}
