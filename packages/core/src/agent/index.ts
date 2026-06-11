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
  /** Appended verbatim after the composed system prompt (CLI --append-system-prompt). */
  appendSystemPrompt?: string;
  /** Internal: marks this session as spawned by dispatch_agent (the agent id). */
  parentAgentId?: string;
};

export interface AgentCore {
  runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent>;
}

export { createAgentCore, createRetryBus, type AgentCoreDeps, type RetryBus } from "./loop.js";
export {
  runAutoLoop,
  type LoopOptions,
  type LoopResult,
  type LoopEvent,
  type LoopStatus,
} from "./auto-loop.js";
export { classifyAgentError } from "./errors.js";
export type { AgentErrorKind, ClassifiedAgentError } from "./errors.js";
export { buildSystemPrompt } from "./prompt.js";
export {
  loadUserCommands,
  expandUserCommand,
  commandTakesArguments,
  COMMAND_ARGUMENTS_PLACEHOLDER,
  type UserCommand,
} from "./commands.js";
export { collectProjectRules, collectRuleFiles, type RuleFile } from "./rules.js";
export {
  compactMessages,
  estimateMessagesTokens,
  estimateTokens,
  llmCompactMessages,
  llmCompactSessionNow,
  type CompactionResult,
  type LlmCompactSessionResult,
  type SummaryProvider,
} from "./context.js";
export {
  appendCheckpoint,
  compactSessionNow,
  createSessionTrace,
  deleteSession,
  forkSession,
  listSessions,
  loadSessionMessages,
  newSessionId,
  pruneSessions,
  readCheckpoints,
  readSessionMeta,
  rewindSession,
  rewindSessionToTurn,
  rewriteSessionMessages,
  sessionTitle,
  truncateSessionAtUserTurn,
  writeSessionMeta,
  type CheckpointEntry,
  type ListSessionsOptions,
  type ManualCompactionResult,
  type PruneResult,
  type PruneSessionsOptions,
  type RewindResult,
  type SessionMeta,
  type TruncateResult,
} from "./trace.js";
