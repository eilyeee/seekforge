/**
 * Tool system module: schemas, permission policy, dispatcher, built-in tools.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDefaultDispatcher(): ToolDispatcher
 */

import type {
  PermissionPolicy,
  PermissionRequest,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";
import { createDispatcher } from "./registry.js";
import { builtinTools } from "./builtins/index.js";
import type { RuntimeClient } from "../runtime/index.js";

export type ToolContext = {
  sessionId: string;
  /** Absolute path of the project workspace; all file access must stay inside. */
  workspace: string;
  policy: PermissionPolicy;
  /** Ask the user. Resolves true if approved. Must be given raw args to display. */
  confirm: (req: PermissionRequest) => Promise<boolean>;
  /**
   * Optional Rust execution backend (seekforge-runtime). When present,
   * fs/command/git tools delegate raw IO to it; permission checks and
   * output post-processing stay in TypeScript.
   */
  runtime?: RuntimeClient;
  /** Optional tool-call audit log sink (JSONL). */
  log?: (entry: Record<string, unknown>) => void;
};

export interface ToolDispatcher {
  /** Tool definitions to advertise to the model. */
  list(): ToolDefinitionForModel[];
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export function createDefaultDispatcher(): ToolDispatcher {
  return createDispatcher(builtinTools());
}

// Additional exports for tests / other modules.
export { ToolError } from "./errors.js";
export { createDispatcher, defineTool } from "./registry.js";
export type { ClassifiedCall, ToolRunOutput, ToolSpec } from "./registry.js";
export { enforcePermission } from "./permissions.js";
export type { PermissionDecision, PermissionOutcome } from "./permissions.js";
export {
  DEFAULT_IGNORE_DIRS,
  isSensitiveBasename,
  resolveForRead,
  resolveForWrite,
  resolveInsideWorkspace,
} from "./sandbox.js";
export { redactSecrets } from "./redact.js";
export {
  BUILTIN_COMMAND_ALLOWLIST,
  classifyCommand,
  normalizeCommand,
  runShellCommand,
} from "./run-command.js";
export { applyEdits, closestRegion } from "./edits.js";
export type { SearchReplaceEdit } from "./edits.js";
export { zodToJsonSchema } from "./json-schema.js";
export { builtinTools } from "./builtins/index.js";
export { truncateHeadTail } from "./text.js";
