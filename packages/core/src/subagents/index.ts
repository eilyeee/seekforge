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
export {
  loadAgentDefinitions,
  loadAgentDefinitionsFromDirs,
  parseAgentMarkdown,
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
  DISPATCH_AGENT_TOOL,
  buildDispatchToolDefinition,
  buildSubagentRoster,
  whitelistDispatcher,
} from "./dispatch.js";
