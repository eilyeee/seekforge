/**
 * Agent loop: session, context budget, tool-call loop, trace, final report.
 */

import type { AgentEvent, ApprovalMode } from "@seekforge/shared";

export type RunAgentTaskInput = {
  projectPath: string;
  task: string;
  mode: "ask" | "edit";
  approvalMode: ApprovalMode;
};

export interface AgentCore {
  runTask(input: RunAgentTaskInput): AsyncIterable<AgentEvent>;
}

export { createAgentCore, type AgentCoreDeps } from "./loop.js";
export { buildSystemPrompt } from "./prompt.js";
export { compactMessages, estimateMessagesTokens, estimateTokens } from "./context.js";
export { createSessionTrace, newSessionId } from "./trace.js";
