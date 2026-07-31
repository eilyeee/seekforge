/** MCP (Model Context Protocol) support — SeekForge as an MCP client (stdio or Streamable HTTP) and as an MCP server (server.ts). */

export { createMcpClient, McpError, RESOURCE_READ_MAX_CHARS } from "./client.js";
export { MAX_MCP_ERROR_CHARS, sanitizeMcpErrorMessage } from "./errors.js";
export { MCP_READONLY_TOOLS, serveMcp } from "./server.js";
export type { McpServerHandle, ServeMcpOptions } from "./server.js";
export type { McpClient, McpClientOptions, McpContentPart, McpToolCallResult } from "./client.js";
export {
  buildMcpToolSpecs,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  loadMcpToolSpecs,
  readMcpResource,
  mcpToolPublicName,
} from "./tools.js";
export type { McpClientEntry, McpPromptRef, McpResourceRef } from "./tools.js";
export type { McpPrompt, McpPromptArgument, McpResource, McpServerConfig, McpTool } from "./types.js";
export {
  buildMcpAuthorizationUrl,
  createMcpOAuthState,
  createMcpPkcePair,
  discoverMcpOAuthMetadata,
  exchangeMcpAuthorizationCode,
  readMcpOAuthCallback,
  registerMcpOAuthClient,
} from "./oauth.js";
export type { McpOAuthClient, McpOAuthMetadata, McpOAuthTokens, McpPkcePair } from "./oauth.js";
export {
  deleteMcpOAuthCredential,
  listMcpOAuthCredentials,
  mcpOAuthStorePath,
  readMcpOAuthCredential,
  recordMcpOAuthTokens,
} from "./oauth-store.js";
export type { McpOAuthCredential } from "./oauth-store.js";
