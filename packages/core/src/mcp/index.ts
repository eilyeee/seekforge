/** MCP (Model Context Protocol) client support — SeekForge as an MCP client over stdio. */

export { createMcpClient, McpError } from "./client.js";
export type { McpClient, McpClientOptions } from "./client.js";
export { buildMcpToolSpecs, loadMcpToolSpecs } from "./tools.js";
export type { McpClientEntry } from "./tools.js";
export type { McpServerConfig, McpTool } from "./types.js";
