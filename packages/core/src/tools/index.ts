/**
 * Tool system module: schemas, permission policy, dispatcher, built-in tools.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDefaultDispatcher(extraTools?: ToolSpec[]): ToolDispatcher
 */

import type {
  PermissionPolicy,
  PermissionRequest,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";
import { createDispatcher, type ToolSpec } from "./registry.js";
import { builtinTools } from "./builtins/index.js";
import type { RuntimeClient } from "../runtime/index.js";
import type { BackgroundTasks } from "./background.js";
import type { HookConfig } from "../hooks/index.js";

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
  /** Per-session background task manager (run_command background:true). */
  background?: BackgroundTasks;
  /**
   * User-configured shell hooks. The dispatcher fires preToolUse (blocking)
   * and postToolUse (advisory) around every tool run; see ../hooks/index.ts.
   */
  hooks?: HookConfig;
  /** Optional tool-call audit log sink (JSONL). */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Records a pre-write snapshot for session rewind. Called by write tools
   * BEFORE writing with the workspace-relative path and the file's current
   * content (null when it does not exist). First-write-wins de-duplication
   * is enforced by the agent loop, not here.
   */
  checkpoint?: (path: string, before: string | null) => void;
};

export interface ToolDispatcher {
  /** Tool definitions to advertise to the model. */
  list(): ToolDefinitionForModel[];
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}

export function createDefaultDispatcher(extraTools: ToolSpec[] = []): ToolDispatcher {
  return createDispatcher([...builtinTools(), ...extraTools]);
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
export { createBackgroundTasks } from "./background.js";
export type {
  BackgroundTasks,
  BackgroundTaskSnapshot,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
} from "./background.js";
export { applyEdits, closestRegion } from "./edits.js";
export type { SearchReplaceEdit } from "./edits.js";
export { zodToJsonSchema } from "./json-schema.js";
export { builtinTools } from "./builtins/index.js";
export { truncateHeadTail } from "./text.js";
