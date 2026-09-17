/**
 * Turns parsed launch flags into the startup state index.tsx renders with.
 * Everything that can reject the launch (an unreadable settings or MCP file, an
 * unknown profile or session, a bad --add-dir) is resolved here, before any
 * MCP server starts or the screen is taken over.
 */

import type { McpServerConfig } from "@seekforge/core";
import { readSessionMeta } from "@seekforge/core";
import { normalizeExtraDir } from "@seekforge/shared/workspace-dirs";
import { resolve } from "node:path";
import { FileTooLargeError, MAX_CONFIG_FILE_BYTES, readTextFileBounded } from "./bounded-file.js";
import { initialApprovalFor, type TuiArgs } from "./cli-args.js";
import {
  ConfigLoadError,
  configMergeWarnings,
  resolveTuiConfig,
  type ConfigLoadOptions,
  type TuiConfig,
} from "./config.js";
import type { ApprovalSetting } from "./model.js";

export type LaunchState = {
  config: TuiConfig;
  /** Where each MCP server came from; --mcp-config servers count as the user's. */
  mcpOrigins: Record<string, "user" | "repository">;
  /** Re-reads the same config layers (for editors that change a file mid-session). */
  loadOptions: ConfigLoadOptions;
  resumeSessionId?: string;
  approval?: ApprovalSetting;
  extraDirs: string[];
  appendSystemPrompt?: string;
  verbose: boolean;
  /** What the config merge narrowed, one line each (shown once the screen is up). */
  configWarnings: string[];
  /** Why the configured apiKeyHelper produced no key. */
  apiKeyHelperError?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads an `--mcp-config` file: either `{ "mcpServers": { … } }` or a bare
 * name → server map, like the CLI flag of the same name.
 */
export function readMcpConfigFile(path: string): Record<string, McpServerConfig> {
  const absPath = resolve(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readTextFileBounded(absPath, MAX_CONFIG_FILE_BYTES));
  } catch (error) {
    const reason = error instanceof FileTooLargeError ? "too large" : "not readable JSON";
    throw new ConfigLoadError(`--mcp-config ${absPath}: ${reason}`, 'expected { "mcpServers": { … } }');
  }
  const servers = isRecord(parsed) && parsed["mcpServers"] !== undefined ? parsed["mcpServers"] : parsed;
  if (!isRecord(servers) || Object.values(servers).some((entry) => !isRecord(entry))) {
    throw new ConfigLoadError(
      `--mcp-config ${absPath}: not a server map`,
      'expected { "mcpServers": { "name": { … } } }',
    );
  }
  return servers as Record<string, McpServerConfig>;
}

export function resolveLaunch(projectPath: string, args: TuiArgs, seams: { home?: string } = {}): LaunchState {
  const loadOptions: ConfigLoadOptions = {
    ...(seams.home ? { home: seams.home } : {}),
    ...(args.settings ? { settingsPath: args.settings } : {}),
    ...(args.profile ? { profile: args.profile } : {}),
  };
  const resolved = resolveTuiConfig(projectPath, loadOptions);
  let config = resolved.config;
  let mcpOrigins: Record<string, "user" | "repository"> = { ...resolved.mcpOrigins };
  if (args.mcpConfig !== undefined) {
    // An explicit file on the command line is the user's, like --settings;
    // it wins per name over the config files.
    const fileServers = readMcpConfigFile(args.mcpConfig);
    config = { ...config, mcpServers: args.strictMcpConfig ? fileServers : { ...config.mcpServers, ...fileServers } };
    if (args.strictMcpConfig) mcpOrigins = {};
    for (const name of Object.keys(fileServers)) mcpOrigins[name] = "user";
  } else if (args.strictMcpConfig) {
    config = { ...config, mcpServers: {} };
    mcpOrigins = {};
  }
  if (args.model) config = { ...config, model: args.model };
  if (args.vim !== undefined) config = { ...config, vim: args.vim };

  if (args.resume !== undefined && !readSessionMeta(projectPath, args.resume)) {
    throw new ConfigLoadError(`no session ${args.resume} in this project`, "run /sessions (or -c) to pick one");
  }

  const extraDirs: string[] = [];
  for (const dir of args.addDirs ?? []) {
    const normalized = normalizeExtraDir(dir, projectPath);
    if (!normalized) {
      throw new ConfigLoadError(
        `--add-dir ${dir}: not a directory outside the workspace`,
        "pass an existing directory that is not inside the project",
      );
    }
    if (!extraDirs.includes(normalized)) extraDirs.push(normalized);
  }

  const approval = initialApprovalFor(args);
  return {
    config,
    mcpOrigins,
    loadOptions,
    ...(args.resume !== undefined ? { resumeSessionId: args.resume } : {}),
    ...(approval ? { approval } : {}),
    extraDirs,
    ...(args.appendSystemPrompt ? { appendSystemPrompt: args.appendSystemPrompt } : {}),
    verbose: args.verbose === true,
    configWarnings: configMergeWarnings(resolved.report),
    ...(resolved.report.apiKeyHelperError !== undefined
      ? { apiKeyHelperError: resolved.report.apiKeyHelperError }
      : {}),
  };
}
