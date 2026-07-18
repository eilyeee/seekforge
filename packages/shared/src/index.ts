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
// Sensitive files (single source of truth; core re-exports this)
// ---------------------------------------------------------------------------

/**
 * Files whose contents must never be read back to the model. Pure (regex
 * only), so it is safe in this browser-safe entry point. Moved here from
 * @seekforge/core tools/sandbox.ts so shared's Node-only helpers (file-refs,
 * workspace-dirs) can use it without a shared→core dependency cycle; core
 * re-exports it, so `import { isSensitiveBasename } from "@seekforge/core"`
 * keeps working.
 */
const SENSITIVE_BASENAME_PATTERNS: RegExp[] = [/^\.env$/, /^\.env\..+$/, /\.pem$/, /\.key$/, /^id_rsa/, /^id_ed25519/];

export function isSensitiveBasename(basename: string): boolean {
  return SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(basename));
}

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

export type SessionStatus = "idle" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

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

export type SubagentStatus = "running" | "done" | "failed" | "cancelled";

export type SubagentEvent =
  | {
      type: "subagent.started";
      dispatchId: string;
      agentId: string;
      task: string;
      status: "running";
    }
  | {
      type: "subagent.step";
      dispatchId: string;
      agentId: string;
      task: string;
      status: "running";
      toolName: string;
      subSessionId?: string;
    }
  | {
      type: "subagent.completed";
      dispatchId: string;
      agentId: string;
      task: string;
      status: "done";
      resultSummary: string;
      subSessionId?: string;
    }
  | {
      type: "subagent.failed";
      dispatchId: string;
      agentId: string;
      task: string;
      status: "failed";
      error: { code: string; message: string };
      resultSummary: string;
      subSessionId?: string;
    }
  | {
      type: "subagent.cancelled";
      dispatchId: string;
      agentId: string;
      task: string;
      status: "cancelled";
      reason: string;
      subSessionId?: string;
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
  | SubagentEvent
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

// ---------------------------------------------------------------------------
// Server API contract (apps/server/SERVER-API.md)
//
// The REST response shapes + WS frame unions of `seekforge serve`, shared by
// @seekforge/server (the producer) and the desktop client (the consumer) as a
// SINGLE SOURCE OF TRUTH. apps/desktop/src/types.ts and lib/ws-types.ts used to
// hand-mirror these; they now re-export from here. Types already declared above
// (AgentEvent, ChatMessage, PermissionRequest, SessionStatus, TokenUsage, …)
// are reused, never reduplicated. These are the ACTUAL server shapes (source of
// truth = apps/server/src/rest.ts + ws.ts, which can drift from prose docs).
// ---------------------------------------------------------------------------

/** GET /api/workspaces entry (one hosted workspace). */
export type Workspace = {
  id: string;
  name: string;
  path: string;
};

/** A recently-opened workspace path (not necessarily hosted right now). */
export type RecentWorkspace = {
  name: string;
  path: string;
};

/** GET /api/workspaces response: currently-hosted workspaces + recent paths. */
export type WorkspacesResponse = {
  workspaces: Workspace[];
  recents: RecentWorkspace[];
};

/** POST /api/worktrees result (the worktree is also a registered Workspace). */
export type WorktreeCreated = {
  /** Workspace id of the worktree (`wt-<slug>`). */
  id: string;
  path: string;
  /** Branch the worktree session runs on (`seekforge/<slug>`). */
  branch: string;
};

/** GET /api/worktrees entry. */
export type WorktreeStatus = {
  id: string;
  branch: string;
  path: string;
  /** Uncommitted changes in the worktree. */
  dirty: boolean;
  /** Commits on the branch not yet on the base HEAD. */
  ahead: number;
};

/** POST /api/worktrees/:id/merge result; conflicts abort and report files. */
export type WorktreeMergeResult = { merged: true } | { conflict: true; files: string[] };

/** GET /api/sessions entry (and GET /api/sessions/:id `meta`). */
export type SessionMeta = {
  id: string;
  task: string;
  mode: "ask" | "edit";
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  usage?: TokenUsage;
};

export type SkillScope = "builtin" | "global" | "project";

/** GET /api/skills[/:id] entry. */
export type Skill = {
  id: string;
  scope: SkillScope;
  name: string;
  description: string;
  tags: string[];
  triggers: string[];
  priority: number;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  /** Full SKILL.md content (only present on GET /api/skills/:id). */
  content?: string;
};

export type MemoryCandidateType = "command" | "path" | "convention" | "tech" | "task_pattern";

export type MemoryCandidate = {
  id: string;
  content: string;
  type: MemoryCandidateType;
  /** 0..1, model-assessed. */
  confidence: number;
  sourceSessionId: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
};

/** An approved project-memory fact joined with its lifecycle metadata. */
export type MemoryFact = {
  /** 1-based position among the bullets of project.md. */
  index: number;
  /** Bullet type, or null when the bullet has no `[type]` prefix. */
  type: MemoryCandidateType | null;
  content: string;
  addedAt?: string;
  uses: number;
  lastUsedAt?: string;
};

/**
 * GET /api/memory response. NOTE: the server (rest.ts) returns `facts` in
 * addition to what SERVER-API.md's prose table lists — the table is stale;
 * code is the source of truth, so `facts` is part of the contract.
 */
export type MemoryResponse = {
  projectMd: string | null;
  candidates: MemoryCandidate[];
  facts: MemoryFact[];
};

/** GET /api/config payload (apiKey masked; engine knobs always present). */
export type ServerConfig = {
  model?: string;
  baseUrl?: string;
  runtimeBin?: string;
  commandAllowlist?: string[];
  /** Selectable model ids for the pickers (always present on GET /api/config). */
  models?: string[];
  /** Masked by the server (`sk-xxx****`). */
  apiKey?: string;
  /** Engine knobs — always present on GET /api/config (effective defaults). */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
  compaction?: "mechanical" | "llm";
  thinking?: boolean;
  reasoningEffort?: "high" | "max" | null;
  /** Model used for plan-mode generation (empty = follow the default model). */
  planModel?: string;
  /** Re-run a failed task with a stronger model/effort once before giving up. */
  escalateOnFailure?: boolean;
  /** Auto-approve extracted memory candidates at/above this confidence (0..1). */
  memoryAutoApproveConfidence?: number;
};

/** PUT /api/config `key` values (same keys as `seekforge config set`). */
export type ConfigKey =
  | "apiKey"
  | "model"
  | "baseUrl"
  | "runtimeBin"
  | "commandAllowlist"
  | "models"
  | "sandbox"
  | "compaction"
  | "thinking"
  | "reasoningEffort"
  | "planModel"
  | "escalateOnFailure"
  | "memoryAutoApproveConfidence";

/** GET /api/memory/stats — mirror of @seekforge/core MemoryStats. */
export type MemoryStats = {
  totalApprovedFacts: number;
  autoExtractedFacts: number;
  directAddedFacts: number;
  /** Fraction (0..1) of approved facts used at least once. */
  usedFraction: number;
  /** Fraction passively exposed in at least one session brief. */
  exposedFraction?: number;
  /** Total explicit search_memory retrievals. */
  retrievalCount?: number;
  /** Candidate rejection rate (0..1). */
  rejectionRate: number;
  avgConfidenceUsed: number | null;
  avgConfidenceUnused: number | null;
  pending: number;
  approved: number;
  rejected: number;
};

/** POST /api/memory/compact — mirror of @seekforge/core CompactResult. */
export type CompactResult = {
  /** Bullet count before compaction. */
  before: number;
  /** Bullet count after compaction. */
  after: number;
  /** Bullet lines removed as exact duplicates. */
  removed: string[];
  /** Near-duplicate merges (longer kept, shorter dropped). */
  merged: Array<{ kept: string; dropped: string }>;
  /** Stale bullets moved to project-archive.md. */
  archived: string[];
};

/** POST /api/sessions/prune result. */
export type PruneResult = { removed: string[]; kept: number };

/** GET /api/doctor — environment health checks. */
export type DoctorReport = {
  apiKeyConfigured: boolean;
  nodeVersion: string;
  git: string | null;
  runtimeBin: { set: boolean; exists: boolean };
  mcpServerCount: number;
  modelCount: number;
  workspace: string;
};

export type AgentScope = "global" | "project" | "builtin";

/** Mirror of @seekforge/core AgentDefinition (GET /api/agents[/:id]). */
export type AgentInfo = {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  /** Tool-name whitelist; undefined = all tools. */
  tools?: string[];
  /** "ask" = read-only governance/review agents; "edit" = executors. */
  mode: "ask" | "edit";
  own?: string;
  doNotTouch?: string;
  boundary?: string;
  maxTurns?: number;
  model?: string;
  scope: AgentScope;
  /** AGENT.md markdown body (only present on GET /api/agents/:id). */
  body?: string;
};

export type EvolutionProposalType = "project_memory" | "agent_rule" | "skill";
export type EvolutionProposalRisk = "low" | "medium" | "high";
export type EvolutionProposalStatus = "pending" | "accepted" | "rejected" | "applied";

/** Mirror of @seekforge/core EvolutionProposal (GET /api/evolution). */
export type EvolutionProposal = {
  id: string;
  sessionId: string;
  type: EvolutionProposalType;
  title: string;
  problem: string;
  evidence: { files?: string[]; commands?: string[]; errors?: string[] };
  proposal: { content: string; skillId?: string };
  risk: EvolutionProposalRisk;
  status: EvolutionProposalStatus;
  createdAt: string;
  reviewedAt?: string;
};

/** GET /api/mcp entry (configured server; nothing is spawned for the list). */
export type McpServer = {
  name: string;
  command: string;
  args: string[];
  trusted: boolean;
  /** Names of configured env vars (values never leave the server). */
  envKeys?: string[];
};

export type McpTool = { name: string; description: string };

/** POST /api/rewind result (mirror of @seekforge/core RewindResult). */
export type RewindResult = {
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason: string }>;
};

/** GET /api/sessions/:id/turns entry — all-user-messages indexing (turn 0 = original task). */
export type SessionTurn = { turn: number; text: string; backtrackable: boolean };

/** POST /api/sessions/:id/backtrack result (files is null when restore was not requested). */
export type BacktrackResult = {
  removedMessages: number;
  keptMessages: number;
  files: { restored: number; deleted: number; skipped: number } | null;
};

/** GET/POST /api/todos entry (.seekforge/todos.md checklist line; 1-based index). */
export type Todo = { index: number; text: string; done: boolean };

/** GET /api/balance payload (DeepSeek account balance; null = unknown). */
export type AccountBalance = { currency: string; totalBalance: string };

/** GET /api/mcp/resources entry. Inline reference syntax: @mcp:<server>:<uri>. */
export type McpResource = { server: string; uri: string; name?: string };

/** GET /api/mcp/prompts entry. */
export type McpPrompt = {
  server: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

/** GET /api/tree entry (one file or directory in a workspace-relative dir). */
export type TreeEntry = { name: string; path: string; type: "file" | "dir" };

/** GET /api/tree?path=<reldir> response (a single directory's listing). */
export type TreeResponse = { path: string; entries: TreeEntry[] };

/** GET /api/file?path=<rel> response (text content; truncated when too large). */
export type FileContent = { path: string; content: string; truncated: boolean };

/** A single changed file in GET /api/git/status. */
export type GitFileStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

/** GET /api/git/status entry. */
export type GitFile = { path: string; status: GitFileStatus; staged: boolean };

/** GET /api/git/status response (notGit set when the workspace is not a repo). */
export type GitStatus = {
  notGit?: boolean;
  branch: string;
  files: GitFile[];
};

/** A custom slash command (GET /api/commands). */
export type SlashCommand = {
  name: string;
  description: string;
  scope: "project" | "user";
  /** Template text inserted into the composer draft when chosen. */
  body: string;
  /** Frontmatter `model`: preferred model for this command (informational here). */
  model?: string;
  /** Frontmatter `allowed-tools`: tool whitelist (informational here). */
  allowedTools?: string[];
  /** Frontmatter `argument-hint`: placeholder shown in the args popup. */
  argumentHint?: string;
};

/** GET /api/commands response. */
export type CommandsResponse = { commands: SlashCommand[] };

/** The nine hook stages, mirroring core's HookStage. */
export const HOOK_STAGES = [
  "preToolUse",
  "postToolUse",
  "sessionStart",
  "userPromptSubmit",
  "preCompact",
  "stop",
  "subagentStop",
  "notification",
  "sessionEnd",
] as const;
export type HookStage = (typeof HOOK_STAGES)[number];

/** One shell hook entry (matches core's HookEntry). */
export type HookEntry = { command: string; match?: string; pattern?: string };

/** Project hooks config: stage → entries. */
export type HooksConfig = Partial<Record<HookStage, HookEntry[]>>;

/** One content-search hit (GET /api/search); col/len locate the match in text. */
export type SearchHit = { path: string; line: number; text: string; col: number; len: number };
export type SearchResult = { hits: SearchHit[]; truncated: boolean; error?: string };

/**
 * Loop-mode result status (server LoopResult.status; mirror of @seekforge/core
 * LoopStatus).
 * - passed: the verify command exited 0.
 * - exhausted: maxIterations reached without passing.
 * - no_progress: the agent stopped making changes / verify stayed failing.
 * - budget: the USD budget was exceeded.
 * - cancelled: the user stopped the loop (cancel frame / closed socket).
 * - verify_error: the verify command itself could not be run.
 * - requirements_pending: confirm-mode requirements await explicit approval.
 */
export type LoopStatus =
  | "passed"
  | "exhausted"
  | "no_progress"
  | "budget"
  | "cancelled"
  | "verify_error"
  | "requirements_pending";
export type LoopRequirementMode = "quick" | "analyze" | "confirm";
export type LoopRequirementSpec = {
  version: 1;
  goal: string;
  deliverables: string[];
  requirements: Array<{ id: string; text: string; required: boolean }>;
  constraints: string[];
  outOfScope: string[];
  assumptions: string[];
  acceptanceCriteria: Array<{ id: string; text: string; requirementIds: string[] }>;
  unresolvedQuestions: string[];
};
export type LoopAcceptanceReview = {
  complete: boolean;
  criteria: Array<{ id: string; status: "met" | "unmet" | "unknown"; evidence: string[] }>;
  gaps: string[];
};

/** Final summary of a loop run (server LoopResult). */
export type LoopResult = {
  status: LoopStatus;
  /** Iterations actually run. */
  iterations: number;
  /** Total cost across all iterations. */
  costUsd: number;
  /** Session id of the underlying agent run. */
  sessionId: string;
  /** Output + exit code of the last verify command. */
  finalVerify: { code: number; output: string };
  /** Stable persisted orchestration id when persistence is enabled. */
  loopId?: string;
  requirements?: LoopRequirementSpec;
  acceptanceReview?: LoopAcceptanceReview;
};

/** A single streamed loop event (server LoopEvent). */
export type LoopEvent =
  | { type: "iteration.start"; iteration: number }
  | { type: "run.completed"; iteration: number; costUsd: number }
  | { type: "verify.output"; iteration: number; stream: "stdout" | "stderr"; chunk: string }
  | { type: "verify"; iteration: number; code: number; passed: boolean; output: string }
  | { type: "requirements.started"; phase: "analysis" | "review" }
  | { type: "requirements.completed"; spec: LoopRequirementSpec; approvalRequired: boolean }
  | { type: "requirements.reviewed"; review: LoopAcceptanceReview }
  | { type: "loop.warning"; warning: "persistence" | "requirements"; message: string }
  | { type: "loop.done"; result: LoopResult };

/**
 * GET /api/models entry. For DeepSeek this mirrors core MODEL_PRICING with
 * metadata; providers without a pricing table (e.g. Ark) return `null`/no
 * pricing, so the field is nullable/optional.
 */
export type ModelInfo = {
  id: string;
  isDefault: boolean;
  deprecated: boolean;
  pricing?: {
    inputCacheMissPer1M: number;
    inputCacheHitPer1M: number;
    outputPer1M: number;
  } | null;
};

/**
 * Every `code` string the server emits in an error response — REST
 * `{error:{code,message}}` (apps/server/src/rest.ts `sendApiError` plus the
 * files.ts / worktrees.ts error classes) and WS `{type:"error",code,message}`
 * frames (apps/server/src/ws.ts). Enumerated so frontends can exhaustively
 * switch on it; this is a type only — it does NOT constrain the server runtime.
 */
export type ApiErrorCode =
  // REST (rest.ts sendApiError + files.ts/worktrees.ts error classes)
  | "bad_request"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "internal"
  | "internal_error"
  | "method_not_allowed"
  | "mcp_error"
  | "security_fix_failed"
  | "security_scan_failed"
  | "session_busy"
  | "threat_model_failed"
  | "too_large"
  | "unauthorized"
  | "unsupported_media_type"
  | "write_failed"
  | "git_error"
  | "not_a_git_repo"
  // WS (ws.ts error frames)
  | "bad_frame"
  | "busy"
  | "unknown_workspace"
  | "unknown_session"
  | "unknown_run"
  | "unknown_request"
  | "not_running"
  | "cancelled"
  | "agent_error"
  | "loop_error"
  | "unknown_dispatch"
  | "dispatch_not_running"
  | "invalid_steering"
  | "steering_queue_full";

/** Per-run model/thinking overrides (win over server config for that run only). */
export type RunOverrides = {
  model?: string;
  thinking?: boolean;
  reasoningEffort?: "high" | "max";
  /** Output style name (built-in or custom); resolved server-side. */
  outputStyle?: string;
  /** Run-local OS sandbox override; absent keeps the project configuration. */
  sandbox?: "off" | "read-only" | "workspace-write" | "restricted";
};

/** WS client → server frames (path /ws). */
export type ClientFrame =
  | ({
      type: "start";
      task: string;
      mode: "edit" | "ask";
      approvalMode: "auto" | "acceptEdits" | "confirm";
      plan?: boolean;
      /** Workspace id (default: first workspace when omitted). */
      ws?: string;
    } & RunOverrides)
  | ({
      type: "send";
      sessionId: string;
      task: string;
      /** edit/ask switchable per follow-up; absent keeps the session's mode. */
      mode?: "edit" | "ask";
      /** Approval mode can change between turns; absent defaults to "confirm". */
      approvalMode?: "auto" | "acceptEdits" | "confirm";
      ws?: string;
    } & RunOverrides)
  | {
      type: "permission.response";
      requestId: string;
      approved: boolean;
      /** "session" = allow this (and similar) for the rest of the session. */
      remember?: "session";
      /** Per-hunk selection for multi-hunk apply_patch calls. */
      selectedHunks?: number[];
    }
  | { type: "question.answer"; id: string; answer: string }
  | ({
      /**
       * Loop mode: run the task, then `verifyCommand`; if it fails, keep fixing
       * and re-running until it passes — autonomously (the server forces
       * acceptEdits), within the iteration/budget limits. Streamed back as
       * `loop.event` frames; the existing `cancel` frame stops it. model/
       * thinking/reasoningEffort overrides (from the run-toolbar) ride along.
       */
      type: "loop";
      task: string;
      verifyCommand: string;
      /** Hard cap on run→verify cycles (server default when omitted). */
      maxIterations?: number;
      /** Optional total USD budget; the loop stops once exceeded. */
      budget?: number;
      requirementMode?: LoopRequirementMode;
      ws?: string;
    } & RunOverrides)
  | ({
      /** Resume persisted Loop orchestration in the selected workspace. */
      type: "loop.resume";
      loopId: string;
      /** Additional iterations added to the persisted limit. */
      addedIterations?: number;
      /** Additional USD added on top of the persisted cumulative budget. */
      addedBudget?: number;
      /** Approve a persisted confirm-mode requirement specification. */
      approveRequirements?: boolean;
      ws?: string;
    } & RunOverrides)
  | { type: "subscribe"; runId: string; afterSeq?: number; ws?: string }
  | { type: "subagent.cancel"; dispatchId: string }
  | { type: "subagent.steer"; dispatchId: string; message: string }
  | { type: "cancel" };

/** WS server → client frames (path /ws). */
export type ServerFrame =
  | {
      type: "hello";
      protocolVersion: number;
      capabilities: readonly string[];
      disconnectPolicy: "cancel";
      backgroundDisconnectPolicy: "continue";
    }
  | ({ type: "run.accepted"; runId: string; status: "queued" } & { seq?: number })
  | ({
      type: "event";
      sessionId: string;
      /**
       * Every AgentEvent plus the server-level model.delta / reasoning.delta
       * streaming events (see SERVER-API.md).
       */
      event: AgentEvent | { type: "model.delta"; chunk: string } | { type: "reasoning.delta"; chunk: string };
    } & { runId?: string; seq?: number })
  | ({ type: "permission.request"; requestId: string; request: PermissionRequest } & {
      runId?: string;
      seq?: number;
    })
  | ({ type: "question.request"; id: string; question: string; options: string[] } & {
      runId?: string;
      seq?: number;
    })
  | ({ type: "loop.event"; event: LoopEvent } & { runId?: string; seq?: number })
  | ({
      type: "subagent.control";
      dispatchId: string;
      operation: "steer" | "cancel";
      status: "accepted";
    } & { runId?: string; seq?: number })
  | ({ type: "error"; code: ApiErrorCode; message: string } & { runId?: string; seq?: number })
  | ({ type: "idle" } & { runId?: string; seq?: number });
