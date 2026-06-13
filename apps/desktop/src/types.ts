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

export type MemoryResponse = {
  projectMd: string | null;
  candidates: MemoryCandidate[];
};

export type ServerConfig = {
  model?: string;
  baseUrl?: string;
  runtimeBin?: string;
  commandAllowlist?: string[];
  /** Masked by the server (`sk-xxx****`). */
  apiKey?: string;
  /** Engine knobs — always present on GET /api/config (effective defaults). */
  sandbox?: "off" | "workspace-write" | "restricted";
  compaction?: "mechanical" | "llm";
  thinking?: boolean;
  reasoningEffort?: "high" | "max" | null;
};

export type ConfigKey = "apiKey" | "model" | "baseUrl" | "runtimeBin" | "commandAllowlist";

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
