/**
 * Settings-flavored routes: custom commands + output styles, the cross-session
 * todo list, account balance, MCP server config/introspection, the doctor
 * panel, and the config/hooks editors.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  createMcpClient,
  expandShellInjections,
  expandUserCommand,
  fetchBalance,
  listMcpPrompts,
  listMcpResources,
  listOutputStyles,
  loadUserCommands,
  MODEL_PRICING,
  resolveProviderPreset,
  type HookConfig,
  type HookEntry,
  type McpClientEntry,
  type McpServerConfig,
} from "@seekforge/core";
import { loadConfig, maskedConfig, setConfigValue } from "../config.js";
import { readJsonBody, sendApiError, sendJson } from "../http.js";
import { addTodo, loadTodos, removeTodo, toggleTodo } from "@seekforge/shared/todos";
import type { RouteCtx } from "./context.js";

const execFileAsync = promisify(execFile);

type ConfigDoc = { mcpServers?: Record<string, McpServerConfig>; [k: string]: unknown };

/**
 * Read-merge-write the workspace .seekforge/config.json mcpServers map: applies
 * `mutate` to the current servers object and writes the file back (mode 0o600).
 * Other top-level keys are preserved; an empty mcpServers map is dropped.
 */
function mutateMcpServers(
  workspace: string,
  mutate: (servers: Record<string, McpServerConfig>) => void,
): void {
  const path = join(workspace, ".seekforge", "config.json");
  let doc: ConfigDoc = {};
  if (existsSync(path)) {
    try {
      doc = JSON.parse(readFileSync(path, "utf8")) as ConfigDoc;
    } catch {
      doc = {};
    }
  }
  const servers = { ...(doc.mcpServers ?? {}) };
  mutate(servers);
  if (Object.keys(servers).length === 0) delete doc.mcpServers;
  else doc.mcpServers = servers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

/** Reads the project config.json (raw); returns {} on missing/invalid. */
function readConfigDoc(workspace: string): ConfigDoc {
  const path = join(workspace, ".seekforge", "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ConfigDoc;
  } catch {
    return {};
  }
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
  const path = join(workspace, ".seekforge", "config.json");
  const doc = readConfigDoc(workspace);
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  else doc.hooks = hooks;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

export async function handle(ctx: RouteCtx): Promise<boolean> {
  await routes(ctx);
  return ctx.res.headersSent;
}

async function routes({ req, res, url, method, segs, workspace }: RouteCtx): Promise<void> {
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
    const text = await expandShellInjections(expanded, (cmd) =>
      execFileAsync("/bin/sh", ["-c", cmd], { cwd: workspace, timeout: 10_000, maxBuffer: 1024 * 1024 })
        .then(({ stdout }) => stdout)
        .catch((err: NodeJS.ErrnoException & { stdout?: string }) =>
          typeof err.stdout === "string" ? err.stdout : Promise.reject(err),
        ),
    );
    return sendJson(res, 200, { text });
  }

  // Cross-session todo list (.seekforge/todos.md, TUI-compatible format).
  if (method === "GET" && path === "/api/todos") {
    return sendJson(res, 200, loadTodos(workspace));
  }

  if (method === "POST" && path === "/api/todos") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { op, text, index } = (body ?? {}) as { op?: unknown; text?: unknown; index?: unknown };
    if (op === "add") {
      if (typeof text !== "string" || text.trim() === "") {
        return sendApiError(res, 400, "bad_request", 'op "add" needs a non-empty text');
      }
      addTodo(workspace, text.trim());
    } else if (op === "toggle" || op === "remove") {
      if (typeof index !== "number" || !Number.isInteger(index)) {
        return sendApiError(res, 400, "bad_request", `op "${op}" needs an integer index (1-based)`);
      }
      const result = op === "toggle" ? toggleTodo(workspace, index) : removeTodo(workspace, index);
      if (result === null) {
        return sendApiError(res, 404, "not_found", `no todo at index ${index}`);
      }
    } else {
      return sendApiError(res, 400, "bad_request", 'op must be "add", "toggle" or "remove"');
    }
    // Every mutation returns the updated list (what the UI re-renders).
    return sendJson(res, 200, loadTodos(workspace));
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
    const balance =
      balanceSupported && config.apiKey ? await fetchBalance(config.apiKey, config.baseUrl) : null;
    return sendJson(res, 200, { balance });
  }

  // Resources of every configured MCP server (resources/list), spawned on
  // demand like POST /api/mcp/:name/tools. A server that fails or lacks
  // resource support contributes zero entries (listMcpResources never throws).
  if (method === "GET" && path === "/api/mcp/resources") {
    const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
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
    const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
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

  if (method === "GET" && path === "/api/mcp") {
    // Configured servers only — never spawned here, env VALUES never exposed.
    const servers = Object.entries(loadConfig(workspace).mcpServers ?? {});
    return sendJson(
      res,
      200,
      servers.map(([name, cfg]) => ({
        name,
        command: cfg.command,
        args: cfg.args ?? [],
        trusted: cfg.trusted === true,
        envKeys: Object.keys(cfg.env ?? {}),
      })),
    );
  }

  // Add or update an MCP server in the workspace config.json.
  if (method === "POST" && path === "/api/mcp") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { name, command, args, env, url: serverUrl, headers, trusted } = (body ?? {}) as {
      name?: unknown;
      command?: unknown;
      args?: unknown;
      env?: unknown;
      url?: unknown;
      headers?: unknown;
      trusted?: unknown;
    };
    if (typeof name !== "string" || name.trim() === "") {
      return sendApiError(res, 400, "bad_request", "body must include a non-empty name");
    }
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
    if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) {
      return sendApiError(res, 400, "bad_request", "env must be an object");
    }
    if (headers !== undefined && (typeof headers !== "object" || headers === null || Array.isArray(headers))) {
      return sendApiError(res, 400, "bad_request", "headers must be an object");
    }
    // Need at least a transport: command (stdio) or url (HTTP).
    if (typeof command !== "string" && typeof serverUrl !== "string") {
      return sendApiError(res, 400, "bad_request", "provide either command (stdio) or url (HTTP)");
    }
    const entry: McpServerConfig = {
      ...(typeof command === "string" ? { command } : {}),
      ...(Array.isArray(args) && args.length > 0 ? { args: args as string[] } : {}),
      ...(env !== undefined ? { env: env as Record<string, string> } : {}),
      ...(typeof serverUrl === "string" ? { url: serverUrl } : {}),
      ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
      ...(trusted !== undefined ? { trusted } : {}),
    };
    mutateMcpServers(workspace, (servers) => {
      servers[name] = entry;
    });
    return sendJson(res, 200, { ok: true });
  }

  // Remove an MCP server from the workspace config.json.
  if (method === "DELETE" && segs.length === 3 && segs[1] === "mcp") {
    const name = segs[2]!;
    const config = loadConfig(workspace).mcpServers ?? {};
    if (!config[name]) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
    mutateMcpServers(workspace, (servers) => {
      delete servers[name];
    });
    return sendJson(res, 200, { ok: true });
  }

  if (method === "POST" && segs.length === 4 && segs[1] === "mcp" && segs[3] === "tools") {
    const name = segs[2]!;
    const config = (loadConfig(workspace).mcpServers ?? {})[name];
    if (!config) return sendApiError(res, 404, "not_found", `MCP server not configured: ${name}`);
    const client = createMcpClient({ name, config });
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
    const hooksInput =
      body !== null && typeof body === "object" ? (body as { hooks?: unknown }).hooks : undefined;
    const result = validateHooks(hooksInput);
    if ("error" in result) {
      return sendApiError(res, 400, "bad_request", result.error);
    }
    writeHooks(workspace, result.hooks);
    return sendJson(res, 200, { hooks: result.hooks });
  }

  if (method === "PUT" && path === "/api/config") {
    const body = await readJsonBody(req, res);
    if (body === undefined) return;
    const { key, value, global } = (body ?? {}) as { key?: unknown; value?: unknown; global?: unknown };
    if (typeof key !== "string") {
      return sendApiError(res, 400, "bad_request", "body must be {key, value, global?}");
    }
    // ConfigValueError (unknown key / bad value) maps to 400 in the
    // trailing catch.
    setConfigValue(workspace, key, value, global === true);
    return sendJson(res, 200, maskedConfig(workspace));
  }
}
