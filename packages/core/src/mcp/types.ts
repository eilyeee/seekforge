/** MCP (Model Context Protocol) client types — stdio and Streamable HTTP transports. */

import type { PermissionName } from "@seekforge/shared";

/** The wire a server speaks. `sse` is the legacy 2024-11-05 HTTP+SSE transport. */
export type McpTransportKind = "stdio" | "http" | "sse";

/**
 * Who stands behind a server definition, which decides what the definition may
 * reach on this machine (see launch.ts):
 * - `user` — written in a layer the repository cannot write;
 * - `project` — written by the checkout and approved by the user for this
 *   workspace, exactly as it reads now;
 * - `untrusted` — written by the checkout and approved by nobody.
 */
export type McpServerTrust = "user" | "project" | "untrusted";

/**
 * One entry under `mcpServers` in .seekforge/config.json (Claude Code-compatible).
 * Exactly one transport applies per server: `type` when present, otherwise
 * `url` present → Streamable HTTP, otherwise `command` (stdio).
 */
export type McpServerConfig = {
  /**
   * Transport, spelled the way Claude Code's `.mcp.json` spells it. Absent →
   * inferred from `url` (Streamable HTTP) or `command` (stdio). `"sse"` is the
   * only way to select the legacy HTTP+SSE transport.
   */
  type?: McpTransportKind;
  /** Executable to spawn for the stdio transport (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra environment variables; merged over the inherited environment (stdio only). */
  env?: Record<string, string>;
  /**
   * HTTP endpoint (e.g. "https://example.com/mcp"). Presence selects the
   * Streamable HTTP transport unless `type` says otherwise; `command`/`args`/
   * `env` are then ignored.
   */
  url?: string;
  /**
   * Extra HTTP headers sent on every request (HTTP transport only), e.g.
   * `{"Authorization": "Bearer <token>"}` for bearer-token servers.
   */
  headers?: Record<string, string>;
  /**
   * Optional OAuth 2 refresh-token configuration for remote HTTP servers.
   * Values may use `${ENV_VAR}` references; refreshed access tokens remain
   * process-local and are never written back to config.
   */
  oauth?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  };
  /**
   * SeekForge-specific connection authorization (default false). Automatic
   * agent discovery connects only trusted servers; their tools run at the
   * "write" permission level (auto-approved with -y, confirmed otherwise).
   * Explicit management actions such as testing a configured server may still
   * connect an untrusted entry because the user initiated that exact action.
   */
  trusted?: boolean;
  /** Default permission for this trusted server's tools. Defaults to annotation-derived/write. */
  permission?: PermissionName;
  /** Per-raw-tool-name permission overrides. */
  toolPermissions?: Record<string, PermissionName>;
};

/** A tool as advertised by an MCP server via tools/list. */
export type McpTool = {
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool's arguments, passed through to the model. */
  inputSchema?: Record<string, unknown>;
  /** Standard MCP behavioral hints; treated conservatively because servers may lie. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

/** A resource as advertised by an MCP server via resources/list. */
export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

/** One part of a resources/read result. */
export type McpResourceContent = { uri?: string; mimeType?: string; text?: string; blob?: string };

/** One declared argument of a prompt (from prompts/list). */
export type McpPromptArgument = {
  name: string;
  description?: string;
  required?: boolean;
};

/** A prompt as advertised by an MCP server via prompts/list. */
export type McpPrompt = {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
};
