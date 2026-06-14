/**
 * @seekforge/shared — cross-cutting plain types.
 * No runtime dependencies. Zod schemas live in @seekforge/core.
 */

// ---------------------------------------------------------------------------
// Permissions (single source of truth: docs/05-tool-system.md §4)
// ---------------------------------------------------------------------------

export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export type PermissionName =
  | "readonly" // L0: auto-allowed
  | "write" // L1: in-workspace writes, confirm by default
  | "execute" // L2: command execution, allowlist may auto-allow
  | "env" // L3: dependency install / env changes, must confirm
  | "dangerous"; // L4: denied by default

export const PERMISSION_LEVEL: Record<PermissionName, PermissionLevel> = {
  readonly: 0,
  write: 1,
  execute: 2,
  env: 3,
  dangerous: 4,
};

/**
 * Graded approval tiers (least → most interactive):
 *  - "auto":       all-allow except the hard L4 denylist (and deny-rules).
 *  - "acceptEdits": auto-allow L1 in-workspace WRITES (write_file/apply_patch)
 *                   but still confirm L2 command execution and L3 env changes.
 *                   The "let it edit freely but ask before running things" tier.
 *  - "confirm":    confirm every L1+ action that is not allowlisted/allow-ruled.
 *  - "manual":     reserved for fully manual flows (treated like "confirm" by
 *                  enforcePermission — every L1+ action is confirmed).
 * Deny-rules and the L4 dangerous denylist stay authoritative over ALL modes.
 */
export type ApprovalMode = "auto" | "acceptEdits" | "confirm" | "manual";

export type PermissionRequest = {
  toolName: string;
  permission: PermissionName;
  /** Human-readable summary. UIs MUST also show the raw fields below. */
  description: string;
  /** Raw command line, when the request is about running a command. */
  command?: string;
  /** Raw path, when the request is about touching a file. */
  path?: string;
  /**
   * Edit-review preview: a unified-diff (current → proposed) for write tools.
   * When present, frontends SHOULD render the diff and turn the prompt into an
   * Accept/Reject review (Reject = deny = no write). Additive — every existing
   * consumer ignores it safely; attached on a best-effort basis (omitted on any
   * failure so the write path is never blocked).
   */
  preview?: { path: string; diff: string };
  /**
   * Per-edit hunks for multi-edit apply_patch calls. Populated when the diff
   * contains more than one hunk (edit index + short preview each). Frontends
   * MAY use this to offer per-hunk selection; the confirm result can then
   * return `{ allow: true, selectedHunks: number[] }`. Single-hunk calls
   * omit this field — behavior is unchanged.
   */
  hunks?: { index: number; preview: string }[];
};

/**
 * Richer confirm result (allow-for-session channel). A frontend's confirm()
 * may return a plain boolean (the original contract — `true`=allow once,
 * `false`=deny) OR this object to also grow the run's session allowlist:
 * `{ allow: true, remember: "session" }` means "yes, and don't ask again this
 * session" — enforcePermission then pushes the classified command prefix
 * (run_command/task_kill) or the tool name into policy.sessionAllowlist so
 * subsequent matching calls auto-allow. `remember` is ignored when allow is
 * false. Additive: the boolean form keeps working unchanged.
 *
 * When a frontend supports per-hunk selection for apply_patch, it may return
 * `{ allow: true, selectedHunks: number[] }` to apply only the chosen edits.
 * `selectedHunks` is ignored when allow is false.
 */
export type ConfirmResult =
  | boolean
  | { allow: boolean; remember?: "session" }
  | { allow: true; selectedHunks: number[] };

/**
 * Fine-grained permission rule. Evaluation: first matching rule of each
 * action category wins; deny rules are scanned before allow rules, so a
 * matching deny always blocks (even readonly tools). Allow rules never
 * rescue "dangerous" calls and never override ask-mode blocking.
 */
export type PermissionRule = {
  action: "allow" | "deny";
  /** Tool name, or "*" for any tool. */
  tool: string;
  /**
   * Prefix matched against the classified command (run_command/task_kill)
   * or path (fs tools); absent = matches any call of that tool.
   */
  match?: string;
};

export type PermissionPolicy = {
  approvalMode: ApprovalMode;
  /** "ask" forbids writes and command execution entirely. */
  mode: "ask" | "edit";
  /** Extra command prefixes the user allowed for auto-run (L2). */
  commandAllowlist: string[];
  /** Fine-grained allow/deny rules, project rules first (first match wins). */
  rules?: PermissionRule[];
  /**
   * In-memory, run-scoped allowlist grown by "allow-for-session" confirmations
   * (confirm returning `{ allow: true, remember: "session" }`). For
   * run_command/task_kill it holds classified command PREFIXES; for other
   * tools it holds bare tool names. A subsequent matching call auto-allows
   * without re-prompting. Mutated in place by enforcePermission, so the caller
   * MUST pass a single array shared across a session's tool calls. NOT
   * persisted (unlike commandAllowlist/rules) — it dies with the run.
   */
  sessionAllowlist?: string[];
};

// ---------------------------------------------------------------------------
// Tool calling
// ---------------------------------------------------------------------------

export type ToolCall = {
  id: string;
  name: string;
  /** Parsed JSON arguments (unvalidated; dispatcher validates). */
  arguments: unknown;
};

export type ToolResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    detail?: unknown;
  };
  meta?: {
    durationMs?: number;
    permission?: PermissionName;
    command?: string;
    path?: string;
    truncated?: boolean;
    /** run_command: the command was rerun without the OS sandbox after a denial. */
    sandboxEscalated?: boolean;
  };
};

/** What gets advertised to the model. */
export type ToolDefinitionForModel = {
  name: string;
  description: string;
  /** JSON Schema object for the parameters. */
  parameters: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Provider (DeepSeek)
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ProviderToolCall = {
  id: string;
  name: string;
  /** Raw JSON string as returned by the model. */
  argumentsJson: string;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  /** Set on role:"tool" messages — which call this result answers. */
  toolCallId?: string;
  /** Set on role:"assistant" messages that requested tool calls. */
  toolCalls?: ProviderToolCall[];
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  /** DeepSeek context-cache hits (subset of promptTokens). */
  cacheHitTokens: number;
  costUsd: number;
};

export type ChatFinishReason = "stop" | "tool_calls" | "length" | "other";

export type ChatResponse = {
  content: string;
  toolCalls: ProviderToolCall[];
  usage: TokenUsage;
  finishReason: ChatFinishReason;
  /** Chain-of-thought text (DeepSeek V4 thinking mode). NEVER sent back. */
  reasoningContent?: string;
};

// ---------------------------------------------------------------------------
// Agent events (docs/04-agent-harness.md §8)
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentError = {
  code: string;
  message: string;
  /** Actionable recovery hint (core agent/errors.ts taxonomy). Additive. */
  hint?: string;
  /**
   * A genuine mid-task failure the user can recover from by resuming the
   * session (file changes + completed steps + checkpoints are preserved).
   * False/absent for user-cancelled runs, which need no recovery guidance.
   * Frontends pair this with the session id to show a "/resume <id>" hint.
   * Additive (round 8).
   */
  recoverable?: boolean;
  /** Session id to resume when recoverable. Set by the loop on failure. */
  sessionId?: string;
};

export type FinalReport = {
  summary: string;
  changedFiles: string[];
  commandsRun: string[];
  verification: string;
  usage: TokenUsage;
};

export type AgentEvent =
  | { type: "session.created"; sessionId: string }
  | { type: "step.started"; title: string }
  | { type: "step.completed"; title: string }
  | { type: "model.message"; content: string }
  | { type: "tool.started"; toolName: string; args: unknown }
  | { type: "tool.completed"; toolName: string; result: ToolResult }
  | { type: "permission.required"; request: PermissionRequest }
  | { type: "context.compacted"; droppedTurns: number; summaryTokens: number }
  /** Micro-compaction: old tool outputs were blanked to save context. */
  | { type: "context.microcompacted"; clearedResults: number }
  | { type: "context.usage"; usedTokens: number; budgetTokens: number; percent: number }
  /**
   * The provider is retrying a transient API failure (429/5xx/network) with
   * backoff. Transient/progress-only: frontends should show a clearing status
   * indicator, NOT a permanent transcript row. Fires once per retry attempt,
   * right before the backoff sleep.
   */
  | { type: "provider.retry"; attempt: number; maxAttempts: number; delayMs: number; reason: string }
  | { type: "usage.updated"; usage: TokenUsage }
  | { type: "file.changed"; path: string }
  | { type: "command.output"; stream: "stdout" | "stderr"; chunk: string }
  /** A user-facing message from a hook (its JSON `systemMessage`); not model output. */
  | { type: "notice"; level: "info" | "warn"; message: string }
  | { type: "session.completed"; report: FinalReport }
  | { type: "session.failed"; error: AgentError };

// ---------------------------------------------------------------------------
// Runtime stdio protocol (crates/runtime/PROTOCOL.md)
// ---------------------------------------------------------------------------

export type RuntimeRequest = {
  id: string;
  method: string;
  /** Always includes `workspace` (absolute path) plus method params. */
  params: Record<string, unknown>;
};

export type RuntimeResponse<T = unknown> = {
  id: string | null;
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

// ---------------------------------------------------------------------------
// Limits (docs/04-agent-harness.md §6) — defaults, all overridable via config
// ---------------------------------------------------------------------------

export const DEFAULT_LIMITS = {
  maxAgentTurns: 50,
  maxToolCalls: 150,
  maxCommandRetries: 5,
  maxEditAttempts: 5,
  maxActiveSkills: 3,
  contextBudgetRatio: 0.8,
  toolOutputMaxChars: 20_000,
} as const;

export type AgentLimits = { -readonly [K in keyof typeof DEFAULT_LIMITS]: number };
