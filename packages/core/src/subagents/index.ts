/**
 * Subagents module (roadmap Phase 6.5): specialist agent definitions,
 * loading, external import, and loop-level dispatch helpers.
 *
 * Definitions live in `.seekforge/agents/<id>/AGENT.md` (project) and
 * `~/.seekforge/agents/<id>/AGENT.md` (global); Claude Code's flat
 * `.claude/agents/*.md` load beside them. Project overrides global. The agent
 * loop advertises a synthetic `dispatch_agent` tool at depth 0 only —
 * dispatched runs never recurse.
 */

export type { AgentDefinition, AgentEffort, AgentPermissionMode, AgentScope } from "./types.js";
export { DEFAULT_SUBAGENT_MAX_TURNS } from "./types.js";
export { BUILTIN_AGENTS } from "./builtins.js";
export {
  frontmatterList,
  parseFrontmatter,
  type FrontmatterMap,
  type FrontmatterValue,
  type ParsedFrontmatter,
} from "./frontmatter.js";
export {
  loadAgentDefinitions,
  loadAgentDefinitionsFromDirs,
  MAX_AGENT_DEFINITION_BYTES,
  parseAgentMarkdown,
  withBuiltinAgents,
  type AgentsDir,
} from "./load.js";
export {
  importExternalAgent,
  parseExternalAgent,
  renderAgentMarkdown,
  type ImportAgentOptions,
  type ParseExternalAgentOptions,
  type ParsedExternalAgent,
} from "./import.js";
export { mapAgentToolList, mapAgentToolName } from "./fields.js";
export { buildSubagentPrompt, type SubagentPromptExtras } from "./prompt.js";
export {
  MAX_INLINE_AGENTS,
  MAX_INLINE_AGENTS_BYTES,
  parseInlineAgentDefinitions,
  withInlineAgents,
} from "./inline.js";
export {
  AGENT_REPORT_TOOL,
  AGENT_RESULT_TOOL,
  AGENT_SEND_TOOL,
  DISPATCH_AGENT_TOOL,
  buildAgentReportToolDefinition,
  buildAgentResultToolDefinition,
  buildAgentSendToolDefinition,
  buildDispatchToolDefinition,
  buildSubagentRoster,
  whitelistDispatcher,
} from "./dispatch.js";
export { createEventQueue, type EventQueue } from "./events.js";
export { formatDispatchUpdates, formatEarlierBackgroundResults } from "./delivery.js";
export {
  DISPATCH_TEAM_TOOL,
  MAX_TEAM_CONCURRENCY,
  MAX_TEAM_MEMBERS,
  buildDispatchTeamToolDefinition,
  validateAgentTeam,
  type AgentTeamPlan,
  type TeamMemberPlan,
  type TeamPlanValidation,
} from "./team.js";
export {
  createDispatchManager,
  MAX_AGENT_REPORT_LENGTH,
  MAX_AGENT_REPORTS_PER_RUN,
  MAX_STEER_MESSAGE_LENGTH,
  MAX_STEER_QUEUE_LENGTH,
  type AgentReport,
  type DispatchControlError,
  type DispatchControlResult,
  type DispatchHooks,
  type DispatchManager,
  type DispatchManagerOptions,
  type DispatchRunner,
  type DispatchSnapshot,
  type DispatchStatus,
  type StartDispatchInput,
} from "./manager.js";
export {
  buildPreloadedSkills,
  effortProviderOptions,
  resolveAgentHooks,
  resolveAgentRunPolicy,
  resolveAgentTools,
  SUBAGENT_SKILLS_MAX_CHARS,
  type AgentRunPolicy,
} from "./policy.js";
export {
  acquireAgentEditLock,
  AgentIsolationError,
  copyAgentTranscript,
  createAgentWorktree,
  discardAgentWorktree,
  tryAcquireAgentEditLock,
  settleAgentWorktree,
  type AgentWorktree,
  type IsolatedChangeOutcome,
} from "./isolation.js";
