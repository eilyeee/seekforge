import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookConfig, McpServerConfig } from "@seekforge/core";
import type { PermissionRule } from "@seekforge/shared";

/**
 * Local copy of the CLI's config type/loader. Apps must not depend on apps,
 * so the precedence logic (env > project > global) is replicated here.
 */
export type TuiConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** Fine-grained allow/deny permission rules (project rules first). */
  permissionRules?: PermissionRule[];
  /** MCP servers (Claude Code-compatible). */
  mcpServers?: Record<string, McpServerConfig>;
  /** User-defined shell hooks fired around tool calls. */
  hooks?: HookConfig;
};

function readJson(path: string): TuiConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TuiConfig;
  } catch {
    return {};
  }
}

/** Precedence: env > project .seekforge/config.json > ~/.seekforge/config.json */
export function loadConfig(projectPath: string): TuiConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  // mcpServers merges per server name (project wins) instead of replacing wholesale.
  const mcpServers = { ...global.mcpServers, ...project.mcpServers };
  // permissionRules concatenates project-then-global: first match wins, so
  // project rules take precedence over global ones.
  const permissionRules = [...(project.permissionRules ?? []), ...(global.permissionRules ?? [])];
  // hooks concatenate per stage, global-then-project: every hook runs.
  const hooks: HookConfig = {};
  for (const stage of ["preToolUse", "postToolUse", "sessionEnd"] as const) {
    const merged = [...(global.hooks?.[stage] ?? []), ...(project.hooks?.[stage] ?? [])];
    if (merged.length > 0) hooks[stage] = merged;
  }
  return {
    ...global,
    ...project,
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
    ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
  };
}
