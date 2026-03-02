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

export type ApprovalMode = "auto" | "confirm" | "manual";

export type PermissionRequest = {
  toolName: string;
  permission: PermissionName;
  /** Human-readable summary. UIs MUST also show the raw fields below. */
  description: string;
  /** Raw command line, when the request is about running a command. */
  command?: string;
  /** Raw path, when the request is about touching a file. */
  path?: string;
};

export type PermissionPolicy = {
  approvalMode: ApprovalMode;
  /** "ask" forbids writes and command execution entirely. */
  mode: "ask" | "edit";
  /** Extra command prefixes the user allowed for auto-run (L2). */
  commandAllowlist: string[];
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
  | { type: "usage.updated"; usage: TokenUsage }
  | { type: "file.changed"; path: string }
  | { type: "command.output"; stream: "stdout" | "stderr"; chunk: string }
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
