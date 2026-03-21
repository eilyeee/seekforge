import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "@seekforge/core";

export type CliConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
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
  return {
    ...global,
    ...project,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
    ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
  };
}
