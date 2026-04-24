/** MCP (Model Context Protocol) client support — SeekForge as an MCP client over stdio or Streamable HTTP. */

export { createMcpClient, McpError, RESOURCE_READ_MAX_CHARS } from "./client.js";
export type { McpClient, McpClientOptions } from "./client.js";
export { buildMcpToolSpecs, listMcpResources, loadMcpToolSpecs, readMcpResource } from "./tools.js";
export type { McpClientEntry, McpResourceRef } from "./tools.js";
export type { McpResource, McpServerConfig, McpTool } from "./types.js";
