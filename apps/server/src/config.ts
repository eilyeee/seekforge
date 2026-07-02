/**
 * Server-local config loading & writing.
 *
 * Mirrors apps/cli/src/config.ts and `seekforge config set` — apps/server must
 * not depend on apps/cli, so the small logic is replicated here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEPRECATED_MODELS, MODEL_PRICING, type HookConfig, type McpServerConfig } from "@seekforge/core";
import type { PermissionRule } from "@seekforge/shared";

/** Default selectable model list (core's non-deprecated ids) when none configured. */
const DEFAULT_MODEL_LIST = Object.keys(MODEL_PRICING).filter(
  (id) => !(DEPRECATED_MODELS as readonly string[]).includes(id),
);

export type ServerConfig = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Provider preset: "deepseek" (default) | "ark" | any preset name. Selects base URL + capabilities. */
  provider?: string;
  /** Path to the seekforge-runtime binary; enables the Rust backend. */
  runtimeBin?: string;
  /** Extra command prefixes allowed to auto-run without confirmation. */
  commandAllowlist?: string[];
  /** Selectable model ids offered in the UI pickers (your own list). */
  models?: string[];
  /** OS-level command sandbox: "workspace-write" or "restricted" (off when unset). */
  sandbox?: "off" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). */
  thinking?: boolean;
  /** Reasoning effort for thinking mode. */
  reasoningEffort?: "high" | "max";
  /** Stronger model for plan runs + failure escalation (same key/endpoint). */
  planModel?: string;
  /**
   * Default-off: hand the run to `planModel` once it loops on a failed tool
   * call. Edit the file directly; not settable via `config set`.
   */
  escalateOnFailure?: boolean;
  /**
   * Default-off: confidence threshold (0..1) above which auto-extracted memory
   * facts are written directly to project.md as approved instead of pending.
   * Edit the file directly; not settable via `config set`.
   */
  memoryAutoApproveConfidence?: number;
  /** Shell hooks fired around tool calls / lifecycle. Edit the file directly. */
  hooks?: HookConfig;
  /** MCP servers (Claude Code-compatible). Edit the file directly; not settable via `config set`. */
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Fine-grained allow/deny permission rules. First match of each action
   * category wins (deny scanned before allow); project rules are merged
   * before global ones. Edit the file directly; not settable via `config set`.
   */
  permissionRules?: PermissionRule[];
};

export const CONFIG_KEYS = [
  "apiKey",
  "model",
  "baseUrl",
  "provider",
  "runtimeBin",
  "commandAllowlist",
  "models",
  // Engine knobs (UI-settable; also editable in the file directly).
  "sandbox",
  "compaction",
  "thinking",
  "reasoningEffort",
  "planModel",
  "escalateOnFailure",
  "memoryAutoApproveConfidence",
] as const;

/** Allowed values for the enum-typed config keys. */
const ENUM_VALUES: Record<string, readonly string[]> = {
  sandbox: ["off", "workspace-write", "restricted"],
  compaction: ["mechanical", "llm"],
  reasoningEffort: ["high", "max"],
};

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
  // permissionRules concatenates project-then-global (first match wins), so
  // project rules take precedence — mirrors the CLI minus the --settings layer.
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

/** Merged config with the apiKey masked for transport (GET /api/config). */
export function maskedConfig(workspace: string): Record<string, unknown> {
  // mcpServers is omitted entirely: entries may carry secret env values
  // (GET /api/mcp exposes a sanitized view instead).
  const { mcpServers: _mcpServers, ...merged } = loadConfig(workspace);
  return {
    ...merged,
    apiKey: merged.apiKey ? `${merged.apiKey.slice(0, 6)}****` : undefined,
    // Selectable model list: the user's configured ids, or core's non-deprecated
    // defaults so the picker is never empty.
    models: merged.models && merged.models.length > 0 ? merged.models : DEFAULT_MODEL_LIST,
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
  if (key === "commandAllowlist" || key === "models") {
    // Array of strings, or a comma-separated string (CLI parity).
    if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
      stored = value.map((s) => s.trim()).filter(Boolean);
    } else if (typeof value === "string") {
      stored = value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      throw new ConfigValueError(`${key} must be a string[] or a comma-separated string`);
    }
  } else if (key === "thinking" || key === "escalateOnFailure") {
    // Desktop sends strings ("true"/"false"); also accept real booleans.
    if (value === true || value === "true") stored = true;
    else if (value === false || value === "false") stored = false;
    else throw new ConfigValueError(`${key} must be true or false`);
  } else if (key === "planModel") {
    // String; empty clears it (back to using the default model).
    if (typeof value !== "string") throw new ConfigValueError("planModel must be a string");
    stored = value.trim() === "" ? undefined : value;
  } else if (key === "memoryAutoApproveConfidence") {
    // Number in 0..1; out of range (or non-numeric) is rejected.
    const num = typeof value === "string" ? Number(value) : value;
    if (typeof num !== "number" || !Number.isFinite(num) || num < 0 || num > 1) {
      throw new ConfigValueError("memoryAutoApproveConfidence must be a number between 0 and 1");
    }
    stored = num;
  } else if (key in ENUM_VALUES) {
    if (typeof value !== "string") throw new ConfigValueError(`${key} must be a string`);
    // reasoningEffort: empty clears it (back to the API default).
    if (key === "reasoningEffort" && value.trim() === "") stored = undefined;
    else if (!ENUM_VALUES[key]!.includes(value)) {
      throw new ConfigValueError(`${key} must be one of: ${ENUM_VALUES[key]!.join(", ")}`);
    } else stored = value;
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
  if (stored === undefined) delete current[key];
  else current[key] = stored;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
}
