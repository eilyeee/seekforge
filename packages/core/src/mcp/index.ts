/** MCP (Model Context Protocol) support — SeekForge as an MCP client (stdio or Streamable HTTP) and as an MCP server (server.ts). */

export { createMcpClient, McpError, RESOURCE_READ_MAX_CHARS } from "./client.js";
export { MCP_READONLY_TOOLS, serveMcp } from "./server.js";
export type { McpServerHandle, ServeMcpOptions } from "./server.js";
export type { McpClient, McpClientOptions } from "./client.js";
export {
  buildMcpToolSpecs,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  loadMcpToolSpecs,
  readMcpResource,
} from "./tools.js";
export type { McpClientEntry, McpPromptRef, McpResourceRef } from "./tools.js";
export type { McpPrompt, McpPromptArgument, McpResource, McpServerConfig, McpTool } from "./types.js";
