/** MCP (Model Context Protocol) client types — stdio and Streamable HTTP transports. */

/**
 * One entry under `mcpServers` in .seekforge/config.json (Claude Code-compatible).
 * Exactly one transport applies per server: `url` present → Streamable HTTP,
 * otherwise `command` (stdio).
 */
export type McpServerConfig = {
  /** Executable to spawn for the stdio transport (e.g. "npx"). */
  command?: string;
  args?: string[];
  /** Extra environment variables; merged over process.env (stdio only). */
  env?: Record<string, string>;
  /**
   * Streamable HTTP endpoint (e.g. "https://example.com/mcp"). Presence
   * selects the HTTP transport; `command`/`args`/`env` are then ignored.
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
   * SeekForge-specific (default false). Untrusted servers' tools run at the
   * "env" permission level (always confirmed, even with -y); trusted servers'
   * tools run at "write" (auto-approved with -y, confirmed otherwise).
   */
  trusted?: boolean;
};

/** A tool as advertised by an MCP server via tools/list. */
export type McpTool = {
  name: string;
  description?: string;
  /** Raw JSON Schema for the tool's arguments, passed through to the model. */
  inputSchema?: Record<string, unknown>;
};

/** A resource as advertised by an MCP server via resources/list. */
export type McpResource = {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

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
