/**
 * Subagents module (roadmap Phase 6.5): specialist agent definitions,
 * loading, external import, and loop-level dispatch helpers.
 *
 * Definitions live in `.seekforge/agents/<id>/AGENT.md` (project) and
 * `~/.seekforge/agents/<id>/AGENT.md` (global); project overrides global.
 * The agent loop advertises a synthetic `dispatch_agent` tool at depth 0
 * only — dispatched runs never recurse.
 */

export type { AgentDefinition, AgentScope } from "./types.js";
export { DEFAULT_SUBAGENT_MAX_TURNS } from "./types.js";
export { BUILTIN_AGENTS } from "./builtins.js";
export {
  loadAgentDefinitions,
  loadAgentDefinitionsFromDirs,
  parseAgentMarkdown,
  withBuiltinAgents,
  type AgentsDir,
} from "./load.js";
export {
  importExternalAgent,
  parseExternalAgent,
  renderAgentMarkdown,
  type ImportAgentOptions,
  type ParsedExternalAgent,
} from "./import.js";
export { buildSubagentPrompt } from "./prompt.js";
export {
  AGENT_RESULT_TOOL,
  AGENT_SEND_TOOL,
  DISPATCH_AGENT_TOOL,
  buildAgentResultToolDefinition,
  buildAgentSendToolDefinition,
  buildDispatchToolDefinition,
  buildSubagentRoster,
  whitelistDispatcher,
} from "./dispatch.js";
export { createEventQueue, type EventQueue } from "./events.js";
export {
  createDispatchManager,
  MAX_STEER_MESSAGE_LENGTH,
  MAX_STEER_QUEUE_LENGTH,
  type DispatchControlError,
  type DispatchControlResult,
  type DispatchHooks,
  type DispatchManager,
  type DispatchRunner,
  type DispatchSnapshot,
  type DispatchStatus,
  type StartDispatchInput,
} from "./manager.js";
