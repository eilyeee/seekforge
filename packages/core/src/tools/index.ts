/**
 * Tool system module: schemas, permission policy, dispatcher, built-in tools.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDefaultDispatcher(): ToolDispatcher
 *
 * Implemented in the tools work stream; placeholder until merged.
 */

import type {
  PermissionPolicy,
  PermissionRequest,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";

export type ToolContext = {
  sessionId: string;
  /** Absolute path of the project workspace; all file access must stay inside. */
  workspace: string;
  policy: PermissionPolicy;
  /** Ask the user. Resolves true if approved. Must be given raw args to display. */
  confirm: (req: PermissionRequest) => Promise<boolean>;
  /** Optional tool-call audit log sink (JSONL). */
  log?: (entry: Record<string, unknown>) => void;
};

export interface ToolDispatcher {
  /** Tool definitions to advertise to the model. */
  list(): ToolDefinitionForModel[];
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export function createDefaultDispatcher(): ToolDispatcher {
  throw new Error("not implemented yet (tools work stream)");
}
