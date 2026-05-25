import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { HookConfig, McpServerConfig } from "@seekforge/core";
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
  /**
   * User-defined shell hooks fired around tool calls. preToolUse hooks can
   * block a tool (non-zero exit); postToolUse/sessionEnd are advisory. Edit
   * the file directly; not settable via `config set`.
   */
  hooks?: HookConfig;
  /** OS-level command sandbox: "workspace-write" or "restricted" (off when unset). */
  sandbox?: "off" | "workspace-write" | "restricted";
  /** Context compaction strategy: "llm" summarizes via the model (default mechanical). */
  compaction?: "mechanical" | "llm";
  /** DeepSeek V4 thinking mode (default: API default). /think toggles in the REPL. */
  thinking?: boolean;
  /** V4 reasoning effort: "high" or "max". */
  reasoningEffort?: "high" | "max";
};

function readJson(path: string): CliConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Read and parse a settings file, throwing a descriptive error on missing or
 * malformed JSON. The error carries a `hint` property so the CLI layer can
 * render it via fail(message, { hint }).
 */
function readSettingsFile(settingsPath: string): CliConfig {
  const absPath = resolve(settingsPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    throw Object.assign(new Error(`settings file not found: ${absPath}`), {
      hint: "check the path and try again",
    });
  }
  try {
    return JSON.parse(raw) as CliConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw Object.assign(new Error(`invalid JSON in settings file ${absPath}: ${msg}`), {
      hint: "ensure the file contains valid JSON",
    });
  }
}

/**
 * Precedence: env > CLI flags > --settings file > project .seekforge/config.json > ~/.seekforge/config.json
 *
 * The --settings layer slots between project config (below) and env vars (above).
 * For deep-merge fields (mcpServers, permissionRules, hooks), the settings
 * layer is merged into the existing logic rather than replacing wholesale.
 */
export function loadConfig(projectPath: string, settingsPath?: string): CliConfig {
  const global = readJson(join(homedir(), ".seekforge", "config.json"));
  const project = readJson(join(projectPath, ".seekforge", "config.json"));
  const settings = settingsPath ? readSettingsFile(settingsPath) : {};

  // mcpServers merges per server name (later wins): settings > project > global.
  const mcpServers = { ...global.mcpServers, ...project.mcpServers, ...settings.mcpServers };
  // permissionRules concatenates settings-then-project-then-global: first match
  // wins, so settings rules take highest precedence among file layers.
  const permissionRules = [
    ...(settings.permissionRules ?? []),
    ...(project.permissionRules ?? []),
    ...(global.permissionRules ?? []),
  ];
  // hooks concatenate per stage: global first, then project, then settings.
  const hooks: HookConfig = {};
  for (const stage of ["preToolUse", "postToolUse", "sessionEnd"] as const) {
    const merged = [
      ...(global.hooks?.[stage] ?? []),
      ...(project.hooks?.[stage] ?? []),
      ...(settings.hooks?.[stage] ?? []),
    ];
    if (merged.length > 0) hooks[stage] = merged;
  }
  return {
    ...global,
    ...project,
    ...settings,
    ...(permissionRules.length > 0 ? { permissionRules } : {}),
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
    ...(process.env["DEEPSEEK_API_KEY"] ? { apiKey: process.env["DEEPSEEK_API_KEY"] } : {}),
    ...(process.env["SEEKFORGE_RUNTIME_BIN"] ? { runtimeBin: process.env["SEEKFORGE_RUNTIME_BIN"] } : {}),
  };
}
