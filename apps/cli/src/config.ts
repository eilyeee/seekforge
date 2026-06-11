import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@seekforge/core";
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
};

function readJson(path: string): CliConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/** Precedence: env > project .seekforge/config.json > ~/.seekforge/config.json */
export function loadConfig(projectPath: string): CliConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  // mcpServers merges per server name (project wins) instead of replacing wholesale.
  const mcpServers = { ...global.mcpServers, ...project.mcpServers };
  // permissionRules concatenates project-then-global: first match wins, so
  // project rules take precedence over global ones.
  const permissionRules = [...(project.permissionRules ?? []), ...(global.permissionRules ?? [])];
  return {
    ...global,
    ...project,
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
    ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
  };
}
