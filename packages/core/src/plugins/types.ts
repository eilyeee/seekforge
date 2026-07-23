import type { HookConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/types.js";

export const PLUGIN_API_VERSION = 1 as const;

export type PluginManifest = {
  apiVersion: typeof PLUGIN_API_VERSION;
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Informational compatibility range displayed by management surfaces. */
  seekforge?: string;
  contributes?: {
    /** Relative roots containing ordinary skill subdirectories. */
    skillRoots?: string[];
    /** Relative roots containing ordinary agent subdirectories. */
    agentRoots?: string[];
    /** Names are automatically namespaced with the plugin id. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Shell hooks activate only after the installed digest is explicitly enabled. */
    hooks?: HookConfig;
  };
};

export type PluginScope = "global" | "project";
export type PluginStatus = "enabled" | "disabled" | "changed" | "review_required" | "invalid";

export type PluginRecord = {
  id: string;
  scope: PluginScope;
  path: string;
  status: PluginStatus;
  digest?: string;
  manifest?: PluginManifest;
  error?: string;
};

export type PluginContributions = {
  skillRoots: string[];
  agentRoots: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: HookConfig;
  plugins: PluginRecord[];
};
