/**
 * Agent loop: session, context budget, tool-call loop, final report.
 * Implemented after provider and tools streams merge; placeholder for now.
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
