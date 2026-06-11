/**
 * Agent loop: session, context budget, tool-call loop, trace, final report.
 */

import type { AgentEvent, ApprovalMode } from "@seekforge/shared";

export type RunAgentTaskInput = {
  projectPath: string;
  task: string;
  mode: "ask" | "edit";
  /** Plan flavor: read-only investigation producing an implementation plan. */
  plan?: boolean;
  approvalMode: ApprovalMode;
  /** Continue an existing session: replays its messages, appends `task`. */
  resumeSessionId?: string;
  /** Cooperative cancellation (Ctrl+C). Checked between turns and tool calls. */
  signal?: AbortSignal;
  /**
   * Internal: replaces buildSystemPrompt entirely (used by dispatch_agent to
   * give nested subagent runs their own prompt). Not part of the public API.
   */
  systemPromptOverride?: string;
  /** Internal: marks this session as spawned by dispatch_agent (the agent id). */
  parentAgentId?: string;
};

export interface AgentCore {
  runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent>;
}

export { createAgentCore, type AgentCoreDeps } from "./loop.js";
export { buildSystemPrompt } from "./prompt.js";
export { collectProjectRules, collectRuleFiles, type RuleFile } from "./rules.js";
export { compactMessages, estimateMessagesTokens, estimateTokens } from "./context.js";
export {
  appendCheckpoint,
  createSessionTrace,
  listSessions,
  loadSessionMessages,
  newSessionId,
  pruneSessions,
  readCheckpoints,
  readSessionMeta,
  rewindSession,
  writeSessionMeta,
  type CheckpointEntry,
  type ListSessionsOptions,
  type PruneResult,
  type PruneSessionsOptions,
  type RewindResult,
  type SessionMeta,
} from "./trace.js";
