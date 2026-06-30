/**
 * Tool system module: schemas, permission policy, dispatcher, built-in tools.
 *
 * Contract (see packages/shared/src/index.ts for the types):
 *   createDefaultDispatcher(extraTools?: ToolSpec[]): ToolDispatcher
 */

import type {
  ConfirmResult,
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
import type { SandboxLevel } from "./os-sandbox.js";

export type ToolContext = {
  sessionId: string;
  /** Absolute path of the project workspace; all file access must stay inside. */
  workspace: string;
  policy: PermissionPolicy;
  /**
   * Ask the user. Must be given raw args to display. May resolve a plain
   * boolean (allow-once / deny — the original contract) OR a ConfirmResult
   * object to also grow the session allowlist (`{ allow, remember: "session" }`).
   * enforcePermission treats `true`/`false` exactly as before.
   */
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  /** Interactive question channel (TUI). Absent in non-interactive runs. */
  askUser?: (q: { question: string; options: string[] }) => Promise<string>;
  /**
   * Optional Rust execution backend (seekforge-runtime). When present,
   * fs/command/git tools delegate raw IO to it; permission checks and
   * output post-processing stay in TypeScript.
   */
  runtime?: RuntimeClient;
  /** Per-session background task manager (run_command background:true). */
  background?: BackgroundTasks;
  /**
   * OS-level sandbox wrapper for run_command (seatbelt on darwin, bwrap on
   * linux). "off" or absent = current behavior (no wrapper).
   */
  sandbox?: SandboxLevel;
  /**
   * User-configured shell hooks. The dispatcher fires preToolUse (blocking)
   * and postToolUse (advisory) around every tool run; see ../hooks/index.ts.
   */
  hooks?: HookConfig;
  /** Optional tool-call audit log sink (JSONL). */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Live command-output sink for foreground run_command. The agent loop
   * wires this per tool call to surface command.output events while the
   * command is still running. Absent = no streaming (current behavior).
   */
  emitOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  /**
   * Records a pre-write snapshot for session rewind. Called by write tools
   * BEFORE writing with the workspace-relative path and the file's current
   * content (null when it does not exist). First-write-wins de-duplication
   * is enforced by the agent loop, not here.
   */
  checkpoint?: (path: string, before: string | null) => void;
  /**
   * When set, apply_patch should only apply the edits at these indices
   * (per-hunk selection). Set by the dispatcher after the user selected
   * specific hunks via the ConfirmResult.selectedHunks channel. Absent =
   * apply all edits (backward-compatible behavior).
   */
  selectedHunks?: number[];
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
  looksLikeSandboxDenial,
  normalizeCommand,
  runShellCommand,
  TEST_COMMAND_TIMEOUT_MS,
} from "./run-command.js";
export { buildSandboxSpec, sandboxedShell } from "./os-sandbox.js";
export type { SandboxLevel, SandboxSpec } from "./os-sandbox.js";
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
export { builtinTools, configureVision, type VisionConfig } from "./builtins/index.js";
export { truncateHeadTail } from "./text.js";
