/** MCP (Model Context Protocol) client types — stdio transport only (v1). */

/** One entry under `mcpServers` in .seekforge/config.json (Claude Code-compatible). */
export type McpServerConfig = {
  /** Executable to spawn (e.g. "npx"). */
  command: string;
  args?: string[];
  /** Extra environment variables; merged over process.env. */
  env?: Record<string, string>;
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
