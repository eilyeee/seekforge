/**
 * Server API contract types — re-exported from @seekforge/shared, the SINGLE
 * SOURCE OF TRUTH shared by @seekforge/server (producer) and this desktop
 * client (consumer). See apps/server/SERVER-API.md and the "Server API
 * contract" section of packages/shared/src/index.ts.
 *
 * This file used to hand-mirror the server shapes; it is now a thin shim so
 * every existing `../types` import across the desktop keeps resolving unchanged.
 * Add desktop-only UI types here as local declarations (none needed today —
 * every type below is genuinely the server contract).
 */
export type {
  Workspace,
  RecentWorkspace,
  WorkspacesResponse,
  WorktreeCreated,
  WorktreeStatus,
  WorktreeMergeResult,
  SessionMeta,
  SkillScope,
  Skill,
  MemoryCandidateType,
  MemoryCandidate,
  MemoryFact,
  MemoryResponse,
  ServerConfig,
  ConfigKey,
  MemoryStats,
  CompactResult,
  PruneResult,
  DoctorReport,
  AgentScope,
  AgentInfo,
  EvolutionProposalType,
  EvolutionProposalRisk,
  EvolutionProposalStatus,
  EvolutionProposal,
  McpTool,
  RewindResult,
  SessionTurn,
  BacktrackResult,
  Todo,
  AccountBalance,
  McpResource,
  McpPrompt,
  TreeEntry,
  TreeResponse,
  FileContent,
  GitFileStatus,
  GitFile,
  GitStatus,
  SlashCommand,
  CommandsResponse,
  HookStage,
  HookEntry,
  HooksConfig,
  SearchHit,
  SearchResult,
  LoopStatus,
  LoopResult,
  LoopEvent,
  ModelInfo,
  ApiErrorCode,
} from "@seekforge/shared";

import type { AgentInfo } from "@seekforge/shared";

export type AgentImportResult = {
  ok: true;
  dir: string;
  agent: Omit<AgentInfo, "scope">;
  droppedTools: string[];
};

export type McpScope = "global" | "project";

export type McpServer = {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args: string[];
  url?: string;
  /** Secret values are always returned as the server's ******** sentinel. */
  env: Record<string, string>;
  headers: Record<string, string>;
  oauth?: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    scope?: string;
  };
  trusted: boolean;
  source: McpScope;
  shadowedGlobal: boolean;
};

export type FindingStatus = "open" | "triaged" | "fixing" | "resolved" | "accepted_risk" | "dismissed" | "reopened";
export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";
export type VerificationStatus = "unverified" | "verified" | "failed" | "stale";

export type SecurityFinding = {
  id: string;
  fingerprint: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: "low" | "medium" | "high";
  category: string;
  cwe?: string;
  recommendation: string;
  evidence: Array<{ path: string; lineStart: number; lineEnd: number; excerpt: string }>;
  source: { scanner: string; version: string; ruleId: string };
  status: FindingStatus;
  verificationStatus: VerificationStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  scanRunId: string;
};

export type SecurityScan = {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  scanner: string;
  scannerVersion: string;
  findingIds: string[];
  error?: string;
};

export type SecurityFix = {
  id: string;
  findingId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "agent_failed" | "verification_failed" | "verified";
  commands: Array<{
    kind: "verify" | "lint";
    command: string;
    exitCode: number;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
  }>;
  scanRunId?: string;
  notes?: string;
};

export type ThreatModel = {
  id: string;
  createdAt: string;
  repository: string;
  summary: string;
  assets: Array<{
    name: string;
    description: string;
    evidence: Array<{ path: string; lineStart: number; lineEnd: number }>;
  }>;
  entryPoints: Array<{
    name: string;
    description: string;
    evidence: Array<{ path: string; lineStart: number; lineEnd: number }>;
  }>;
  trustBoundaries: Array<{
    name: string;
    description: string;
    evidence: Array<{ path: string; lineStart: number; lineEnd: number }>;
  }>;
  dataFlows: Array<{
    name: string;
    description: string;
    evidence: Array<{ path: string; lineStart: number; lineEnd: number }>;
  }>;
  threats: Array<{
    id: string;
    title: string;
    scenario: string;
    affectedAssets: string[];
    entryPoints: string[];
    trustBoundaries: string[];
    mitigations: string[];
    severity: FindingSeverity;
    evidence: Array<{ path: string; lineStart: number; lineEnd: number }>;
  }>;
};

export type SecurityEvidencePackage = {
  schemaVersion: 1;
  generatedAt: string;
  repository: string;
  findings: SecurityFinding[];
  scans: SecurityScan[];
  fixes: SecurityFix[];
  threatModels: ThreatModel[];
  events: unknown[];
  disclaimer: string;
};

// HOOK_STAGES is a const value (not only a type), so re-export it as a value.
export { HOOK_STAGES } from "@seekforge/shared";
