/**
 * Agent loop: session, context budget, tool-call loop, trace, final report.
 */

import type { AgentEvent, ApprovalMode } from "@seekforge/shared";

export type RunAgentTaskInput = {
  projectPath: string;
  task: string;
  mode: "ask" | "edit";
  approvalMode: ApprovalMode;
  /** Continue an existing session: replays its messages, appends `task`. */
  resumeSessionId?: string;
  /** Cooperative cancellation (Ctrl+C). Checked between turns and tool calls. */
  signal?: AbortSignal;
};

export interface AgentCore {
  runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent>;
}

export { createAgentCore, type AgentCoreDeps } from "./loop.js";
export { buildSystemPrompt } from "./prompt.js";
export { compactMessages, estimateMessagesTokens, estimateTokens } from "./context.js";
export {
  createSessionTrace,
  listSessions,
  loadSessionMessages,
  newSessionId,
  readSessionMeta,
  writeSessionMeta,
  type SessionMeta,
} from "./trace.js";
