import type { HookConfig } from "../hooks/index.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { BuiltinGraphHandlerId } from "../agent/graph-declarative-handlers.js";

export const PLUGIN_API_VERSION = 1 as const;

/**
 * A language server a plugin (or the user's `lspServers` config) contributes.
 * Either `extensionToLanguage` (Claude Code's `.lsp.json` shape) or the pair
 * `extensions` + `languageId` says which files it serves.
 */
export type LspServerConfig = {
  command: string;
  args?: string[];
  /** Extra environment for the server process, merged over the inherited one. */
  env?: Record<string, string>;
  /** `.ext` → LSP languageId. */
  extensionToLanguage?: Record<string, string>;
  /** `.ext` list served with one `languageId`. */
  extensions?: string[];
  languageId?: string;
  /** Sent verbatim as `initializationOptions` in the initialize request. */
  initializationOptions?: unknown;
};

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
    /** Relative roots of slash-command Markdown files, exposed as `<plugin>:<name>`. */
    commandRoots?: string[];
    /** Relative roots of output-style Markdown files, exposed as `<plugin>:<name>`. */
    outputStyleRoots?: string[];
    /** Names are automatically namespaced with the plugin id. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Language servers; the user's own `lspServers` config overrides these. */
    lspServers?: Record<string, LspServerConfig>;
    /** Shell hooks activate only after the installed digest is explicitly enabled. */
    hooks?: HookConfig;
    /** Safe aliases to deterministic built-in Graph handlers. */
    graphHandlers?: Record<string, BuiltinGraphHandlerId>;
    /** Aliases to host-registered trusted remote executors; no code is loaded from the plugin. */
    graphExecutors?: Record<string, string>;
  };
};

export type PluginScope = "global" | "project";
export type PluginStatus = "enabled" | "disabled" | "changed" | "review_required" | "invalid";
/** Which manifest a plugin directory ships: `plugin.json` or `.claude-plugin/plugin.json`. */
export type PluginFormat = "seekforge" | "claude";

/**
 * Where an installed plugin came from, recorded at install time. Informational:
 * the approval is bound to the digest of what was installed, never to this.
 */
export type PluginOrigin =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; ref?: string; commit: string; subdir?: string }
  | { kind: "archive"; url: string; sha256: string; subdir?: string }
  | { kind: "marketplace"; marketplace: string; plugin: string; source: PluginOrigin };

export type PluginRecord = {
  id: string;
  scope: PluginScope;
  path: string;
  status: PluginStatus;
  digest?: string;
  manifest?: PluginManifest;
  format?: PluginFormat;
  origin?: PluginOrigin;
  /** Parts of a Claude Code plugin SeekForge could not map (reported, never fatal). */
  warnings?: string[];
  error?: string;
};

export type PluginCommandRoot = { plugin: string; path: string };

export type PluginContributions = {
  skillRoots: string[];
  agentRoots: string[];
  /** Command roots; each command is named `<plugin>:<relative name>`. */
  commandRoots?: PluginCommandRoot[];
  /** Output-style roots; each style is named `<plugin>:<file name>`. */
  outputStyleRoots?: PluginCommandRoot[];
  mcpServers: Record<string, McpServerConfig>;
  lspServers?: Record<string, LspServerConfig>;
  hooks: HookConfig;
  graphHandlers?: Record<string, BuiltinGraphHandlerId>;
  graphExecutors?: Record<string, string>;
  plugins: PluginRecord[];
};
