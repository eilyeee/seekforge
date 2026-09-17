/** MCP (Model Context Protocol) support — SeekForge as an MCP client (stdio or Streamable HTTP) and as an MCP server (server.ts). */

export { createMcpClient, McpError, RESOURCE_READ_MAX_CHARS } from "./client.js";
export { createMcpElicitationHandler, createMcpSamplingHandler } from "./handlers.js";
export type { ElicitationHandlerDeps, SamplingHandlerDeps, SamplingProvider } from "./handlers.js";
export {
  clientCapabilities,
  parseElicitationRequest,
  parseSamplingRequest,
  createServerRequestResponder,
} from "./server-requests.js";
export type {
  ElicitationField,
  ElicitationHandler,
  ElicitationRequest,
  ElicitationResult,
  McpServerRequestHandlers,
  SamplingHandler,
  SamplingRequest,
  SamplingResult,
} from "./server-requests.js";
export { MAX_MCP_ERROR_CHARS, sanitizeMcpErrorMessage } from "./errors.js";
export { MCP_READONLY_TOOLS, serveMcp } from "./server.js";
export type { McpServerHandle, ServeMcpOptions } from "./server.js";
export type { McpClient, McpClientOptions, McpContentPart, McpToolCallResult } from "./client.js";
export {
  buildMcpToolSpecs,
  getMcpPrompt,
  listMcpPrompts,
  listMcpResources,
  readMcpResource,
  mcpToolPublicName,
  MCP_IMAGE_MAX_BYTES,
  MCP_IMAGES_MAX_PER_RESULT,
} from "./tools.js";
export type { McpClientEntry, McpPromptRef, McpResourceRef } from "./tools.js";
export {
  createMcpAwareDispatcher,
  DEFAULT_MCP_TOOL_SEARCH_THRESHOLD,
  loadMcpToolSpecs,
  mcpConnectionDecision,
} from "./registry.js";
export type {
  LoadMcpOptions,
  McpConnectionDecision,
  McpRegistry,
  McpRegistryEvent,
  McpServerState,
  McpServerStatus,
} from "./registry.js";
export { asAdaptiveToolDispatcher } from "./adaptive.js";
export type { AdaptiveToolDispatcher } from "./adaptive.js";
export { LIST_MCP_RESOURCES_TOOL, READ_MCP_RESOURCE_TOOL, TOOL_SEARCH_TOOL } from "./meta-tools.js";
export {
  approveProjectMcpServer,
  formatMcpServerDefinition,
  listPendingProjectMcpServers,
  listProjectMcpServers,
  mcpServerDigest,
  projectMcpApprovalsPath,
  projectMcpServerStatus,
  rejectProjectMcpServer,
  resetProjectMcpChoices,
} from "./approvals.js";
export type { ProjectMcpDecision, ProjectMcpServer, ProjectMcpServerStatus } from "./approvals.js";
export {
  McpDefinitionError,
  parseMcpEnvAssignment,
  parseMcpHeaderAssignment,
  parseMcpServerDefinition,
  validateMcpServerName,
} from "./definition.js";
export {
  defaultMcpServerTrust,
  expandMcpEnvRefs,
  mcpChildEnv,
  mcpTransportOf,
  resolveMcpServerConfig,
} from "./launch.js";
export type {
  McpPrompt,
  McpPromptArgument,
  McpResource,
  McpResourceContent,
  McpServerConfig,
  McpServerTrust,
  McpTool,
  McpTransportKind,
} from "./types.js";
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
