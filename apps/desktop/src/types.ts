/**
 * UI-side mirrors of server types that are NOT exported by @seekforge/shared.
 * Shapes follow apps/server/SERVER-API.md (the binding contract) and the
 * corresponding @seekforge/core definitions.
 */
import type { SessionStatus, TokenUsage } from "@seekforge/shared";

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

export type MemoryResponse = {
  projectMd: string | null;
  candidates: MemoryCandidate[];
  facts: MemoryFact[];
};

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
  sandbox?: "off" | "workspace-write" | "restricted";
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

/**
 * Loop-mode result status (server LoopResult.status). Mirrors the server
 * contract; not exported by @seekforge/shared.
 * - passed: the verify command exited 0.
 * - exhausted: maxIterations reached without passing.
 * - no_progress: the agent stopped making changes / verify stayed failing.
 * - budget: the USD budget was exceeded.
 * - cancelled: the user stopped the loop (cancel frame / closed socket).
 * - verify_error: the verify command itself could not be run.
 */
export type LoopStatus = "passed" | "exhausted" | "no_progress" | "budget" | "cancelled" | "verify_error";

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
};

/** A single streamed loop event (server LoopEvent). */
export type LoopEvent =
  | { type: "iteration.start"; iteration: number }
  | { type: "run.completed"; iteration: number; costUsd: number }
  | { type: "verify"; iteration: number; code: number; passed: boolean; output: string }
  | { type: "loop.done"; result: LoopResult };

/** GET /api/models entry (mirror of core MODEL_PRICING with metadata). */
export type ModelInfo = {
  id: string;
  isDefault: boolean;
  deprecated: boolean;
  pricing: {
    inputCacheMissPer1M: number;
    inputCacheHitPer1M: number;
    outputPer1M: number;
  };
};
