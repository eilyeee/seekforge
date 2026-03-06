/**
 * UI-side mirrors of server types that are NOT exported by @seekforge/shared.
 * Shapes follow apps/server/SERVER-API.md (the binding contract) and the
 * corresponding @seekforge/core definitions.
 */
import type { SessionStatus, TokenUsage } from "@seekforge/shared";

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
};

export type ConfigKey = "apiKey" | "model" | "baseUrl" | "runtimeBin" | "commandAllowlist";
