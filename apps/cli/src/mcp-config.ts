// Pure helpers for `mcp add` / `mcp remove`: mutate the mcpServers map in a
// .seekforge/config.json document without losing other keys. Kept separate
// from disk I/O so the mutation logic is unit-testable.

import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@seekforge/core";
import { MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { writeStatePath } from "./project-state.js";

type ConfigDoc = { mcpServers?: Record<string, McpServerConfig>; [k: string]: unknown };

function isObjectRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Resolve the config.json path: project .seekforge/ or global ~/.seekforge/. */
export function mcpConfigPath(projectPath: string, global: boolean): string {
  const base = global ? homedir() : projectPath;
  return join(base, ".seekforge", "config.json");
}

/**
 * Returns a new config document with `name` added to mcpServers. Throws if a
 * server with that name already exists (callers can offer --force later) or if
 * the command is empty. Pure — does not touch disk.
 */
export function addMcpServer(doc: ConfigDoc, name: string, command: string, args: string[]): ConfigDoc {
  if (!name.trim()) throw new Error("server name must not be empty");
  if (!command.trim()) throw new Error("command must not be empty");
  const servers = doc.mcpServers ?? {};
  if (servers[name]) throw new Error(`MCP server "${name}" already exists (remove it first)`);
  const entry: McpServerConfig = { command, ...(args.length > 0 ? { args } : {}) };
  return { ...doc, mcpServers: { ...servers, [name]: entry } };
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
