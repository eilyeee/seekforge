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
  PermissionRule,
  ToolCall,
  ToolDefinitionForModel,
  ToolResult,
} from "@seekforge/shared";
import { createDispatcher, type ToolSpec } from "./registry.js";
import { builtinTools } from "./builtins/index.js";
import type { RuntimeClient } from "../runtime/index.js";
import type { BackgroundTasks } from "./background.js";
import type { HookConfig, HookPromptEvaluator, ToolHookFeedback } from "../hooks/index.js";
import type { SandboxLevel, SandboxProfile } from "./os-sandbox.js";
import type { SkillSession } from "../skills/invocation.js";
import type { CheckpointOrigin, ShellCheckpointNote } from "./shell-checkpoint.js";
import type { FileLedger } from "./file-ledger.js";

export type ToolContext = {
  sessionId: string;
  /** Absolute path of the project workspace; all file access must stay inside. */
  workspace: string;
  policy: PermissionPolicy & {
    /** Exact run-scoped tool allow-list. Names outside it fail closed. */
    allowedTools?: readonly string[];
  };
  /**
   * Ask the user. Must be given raw args to display. May resolve a plain
   * boolean (allow-once / deny — the original contract) OR a ConfirmResult
   * object to also grow the session allowlist (`{ allow, remember: "session" }`).
   * enforcePermission treats `true`/`false` exactly as before.
   */
  confirm: (req: PermissionRequest) => Promise<ConfirmResult>;
  /**
   * Where a `remember: "always"` approval is written. Absent = the frontend is
   * never offered the durable choice (core omits `rememberRule` from the
   * request), so a host that has nowhere trustworthy to write cannot be talked
   * into pretending otherwise.
   *
   * It must be a USER-owned config layer. A repository-owned one would be
   * pointless and misleading: sanitizeProjectConfig strips every allow rule
   * from a project layer on load, so the rule would be written, displayed as
   * saved, and silently ignored forever after.
   */
  persistRule?: (rule: PermissionRule) => Promise<void> | void;
  /** Cancels foreground work when the current agent run is aborted. */
  signal?: AbortSignal;
  /**
   * Interactive question channel. Absent in non-interactive runs.
   *
   * `options` is never empty, so a frontend that does not implement `freeText`
   * still shows an answerable question. `freeText` asks for a typed answer in
   * addition to the choices — an open question ships one "Skip" option so
   * declining stays possible everywhere.
   */
  askUser?: (q: { question: string; options: string[]; freeText?: boolean }) => Promise<string>;
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
   * linux). "off" or absent = current behavior (no wrapper). A profile adds
   * writable roots or a domain allowlist (see sandboxForRun).
   */
  sandbox?: SandboxLevel | SandboxProfile;
  /**
   * Absolute directories outside the workspace that the file tools may read
   * and write, under the same permission levels as the workspace. Granted by
   * the user (CLI flag, TUI command, user config) — never by repository config.
   */
  additionalDirectories?: readonly string[];
  /**
   * User-configured hooks. The dispatcher fires preToolUse (before the
   * permission prompt), permissionRequest (in place of a prompt it can
   * answer), and postToolUse / postToolUseFailure (after the run); see
   * ../hooks/index.ts.
   */
  hooks?: HookConfig;
  /** Evaluates prompt-type hooks. Absent = those hooks fail (and block a blocking stage). */
  hookEvaluate?: HookPromptEvaluator;
  /**
   * Per-call sink for what a tool-stage hook asks of the host: context for the
   * model beside the result, notices for the user, or ending the run. The
   * agent loop wires it per call; absent = that output is dropped.
   */
  onHookFeedback?: (feedback: ToolHookFeedback) => void;
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
   * is enforced by the agent loop, not here. run_command calls it AFTER the
   * command, for the files a git comparison found changed, with `origin`.
   */
  checkpoint?: (path: string, before: string | null, origin?: CheckpointOrigin) => void;
  /**
   * Records what a shell command's checkpoint covered, or why it covered
   * nothing (outside git, over the limits), so rewind can say what it cannot
   * undo. Absent = not recorded.
   */
  recordShellCheckpoint?: (note: ShellCheckpointNote) => void;
  /**
   * When set, apply_patch should only apply the edits at these indices
   * (per-hunk selection). Set by the dispatcher after the user selected
   * specific hunks via the ConfirmResult.selectedHunks channel. Absent =
   * apply all edits (backward-compatible behavior).
   */
  selectedHunks?: number[];
  /**
   * Whatever the tool's own `prepare` step computed for this call (see
   * ToolSpec.prepare). Set by the dispatcher, call-local, and typed as unknown
   * because only the tool that produced it knows its shape — it exists so a
   * write applies exactly the change the user reviewed, rather than recomputing
   * it against a workspace that may have moved on.
   */
  prepared?: unknown;
  /**
   * The run's skill session (skills/invocation.ts): the skill snapshot
   * `invoke_skill` resolves against, and the run-scoped state an activated
   * skill changes. Absent outside an agent run.
   */
  skills?: SkillSession;
  /**
   * What the model has read or written this run (see file-ledger.ts). When
   * present, apply_patch and write_file(overwrite) refuse to change an existing
   * file the model has not read, or that changed since it last did. Absent =
   * unguarded, the behavior for SDK callers and `mcp-serve`.
   */
  fileLedger?: FileLedger;
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
export { createDispatcher, defineTool, TOOL_NAME_PATTERN } from "./registry.js";
export type { ClassifiedCall, PreparedCall, ToolRunOutput, ToolSpec } from "./registry.js";
export { enforcePermission, proposeDurableRule } from "./permissions.js";
export type { PermissionDecision, PermissionOutcome } from "./permissions.js";
export {
  DEFAULT_IGNORE_DIRS,
  isSensitiveBasename,
  resolveAdditionalDirectories,
  resolveForRead,
  resolveForWrite,
  resolveInsideWorkspace,
  toolPathRoot,
} from "./sandbox.js";
export { redactSecrets } from "./redact.js";
export {
  BUILTIN_COMMAND_ALLOWLIST,
  classifyCommand,
  commandInvokes,
  looksLikeSandboxDenial,
  normalizeCommand,
  runShellCommand,
  TEST_COMMAND_TIMEOUT_MS,
} from "./run-command.js";
export {
  buildSandboxSpec,
  composeSandboxProfiles,
  probeSandboxCapabilities,
  resolveSandboxNetwork,
  sandboxedShell,
  sandboxForRun,
} from "./os-sandbox.js";
export type {
  SandboxCapabilityProbe,
  SandboxLevel,
  SandboxNetwork,
  SandboxNetworkAllowlist,
  SandboxProfile,
  SandboxSpec,
} from "./os-sandbox.js";
export {
  hostWithinDomain,
  parseSandboxNetworkPolicy,
  SandboxNetworkConfigError,
  type SandboxNetworkPolicy,
} from "./network-policy.js";
export { ensureNetworkProxy, type BlockedConnection, type NetworkProxy } from "./network-proxy.js";
export { createBackgroundTasks } from "./background.js";
export type {
  BackgroundTaskExitNotice,
  BackgroundTasks,
  BackgroundTaskSnapshot,
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  BackgroundTaskEvent,
} from "./background.js";
export { SHELL_CHECKPOINT_LIMITS } from "./shell-checkpoint.js";
export type { CheckpointOrigin, ShellCheckpointNote } from "./shell-checkpoint.js";
export { createFileLedger } from "./file-ledger.js";
export type { FileLedger, FileStamp } from "./file-ledger.js";
export { WorkspaceIgnore } from "./gitignore.js";
export { applyEdits, closestRegion } from "./edits.js";
export type { SearchReplaceEdit } from "./edits.js";
export { zodToJsonSchema } from "./json-schema.js";
export { browserBackendInstalled } from "./browser/playwright.js";
export { configureLspServers, lspServerCommands } from "./lsp/client.js";
export { lspServersSchema, parseLspServerConfig, resolveLspServerTable } from "./lsp/config.js";
export {
  acquireBrowserLease,
  browserProfileDir,
  configureBrowserProfile,
  resolveBrowserProfilePath,
  acquireLspServerLease,
  builtinTools,
  configureVision,
  configureWebSearch,
  resolveWebSearchConfig,
  disposeBrowser,
  disposeLspServers,
  type BrowserLease,
  type LspServerLease,
  type VisionConfig,
  type WebSearchConfig,
} from "./builtins/index.js";
export { truncateHeadTail, digestCommandOutput } from "./text.js";
