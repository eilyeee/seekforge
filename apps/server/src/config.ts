/**
 * Server-local config loading & writing.
 *
 * Mirrors apps/cli/src/config.ts and `seekforge config set` — apps/server must
 * not depend on apps/cli, so the small logic is replicated here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@seekforge/core";

export type ServerConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** OS-level command sandbox: "workspace-write" or "restricted" (off when unset). */
  sandbox?: "off" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). */
  thinking?: boolean;
  /** Reasoning effort for thinking mode. */
  reasoningEffort?: "high" | "max";
  /** MCP servers (Claude Code-compatible). Edit the file directly; not settable via `config set`. */
  mcpServers?: Record<string, McpServerConfig>;
};

export const CONFIG_KEYS = ["apiKey", "model", "baseUrl", "runtimeBin", "commandAllowlist"] as const;

export class ConfigValueError extends Error {}

function readJson(path: string): ServerConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ServerConfig;
  } catch {
    return {};
  }
}

/** Precedence: env > project .seekforge/config.json > ~/.seekforge/config.json */
export function loadConfig(workspace: string): ServerConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(workspace, ".seekforge", "config.json"));
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

/** Merged config with the apiKey masked for transport (GET /api/config). */
export function maskedConfig(workspace: string): Record<string, unknown> {
  // mcpServers is omitted entirely: entries may carry secret env values
  // (GET /api/mcp exposes a sanitized view instead).
  const { mcpServers: _mcpServers, ...merged } = loadConfig(workspace);
  return {
    ...merged,
    apiKey: merged.apiKey ? `${merged.apiKey.slice(0, 6)}****` : undefined,
    // Engine knobs are always present (with their effective defaults) so the
    // UI can render the sandbox badge / thinking controls without guessing.
    sandbox: merged.sandbox ?? "off",
    compaction: merged.compaction ?? "mechanical",
    thinking: merged.thinking ?? false,
    reasoningEffort: merged.reasoningEffort ?? null,
  };
}

/**
 * Same keys/validation as `seekforge config set`.
 * Throws ConfigValueError on an unknown key or a bad value (HTTP 400).
 */
export function setConfigValue(workspace: string, key: string, value: unknown, global: boolean): void {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new ConfigValueError(`unknown key "${key}". Allowed: ${CONFIG_KEYS.join(", ")}`);
  }

  let stored: unknown;
  if (key === "commandAllowlist") {
    // Array of prefixes, or a comma-separated string (CLI parity).
    if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
      stored = value.map((s) => s.trim()).filter(Boolean);
    } else if (typeof value === "string") {
      stored = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new ConfigValueError("commandAllowlist must be a string[] or a comma-separated string");
    }
  } else {
    if (typeof value !== "string") {
      throw new ConfigValueError(`${key} must be a string`);
    }
    stored = value;
  }

  const path = join(global ? homedir() : workspace, ".seekforge", "config.json");
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      // invalid JSON: rewrite from scratch (same behaviour as the CLI)
    }
  }
  current[key] = stored;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
