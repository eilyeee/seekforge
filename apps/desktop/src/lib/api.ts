/** REST client per SERVER-API.md; attaches Authorization: Bearer <token>. */
import type { AgentEvent, ChatMessage } from "@seekforge/shared";
import { isMock } from "../mock";
import type {
  AccountBalance,
  AgentImportResult,
  AgentInfo,
  BacktrackResult,
  CommandsResponse,
  CompactResult,
  ConfigKey,
  DoctorReport,
  EvolutionProposal,
  FileContent,
  GitStatus,
  HooksConfig,
  McpPrompt,
  McpResource,
  McpScope,
  McpServer,
  McpTool,
  MemoryCandidate,
  MemoryCandidateType,
  MemoryResponse,
  MemoryStats,
  ModelInfo,
  PruneResult,
  RewindResult,
  SearchResult,
  SecurityEvidencePackage,
  SecurityFinding,
  SecurityFix,
  ServerConfig,
  SessionMeta,
  SessionTurn,
  Skill,
  SkillScope,
  Todo,
  ThreatModel,
  TreeResponse,
  Workspace,
  WorkspacesResponse,
  WorktreeCreated,
  WorktreeMergeResult,
  WorktreeStatus,
} from "../types";

let tokenProvider: () => string = () => "";

/** Wired up by the store at boot (avoids an import cycle). */
export function setTokenProvider(fn: () => string): void {
  tokenProvider = fn;
}

/** Returns the active workspace id; empty = the server's default workspace. */
let wsProvider: () => string = () => "";

/** Wired up by the store at boot (avoids an import cycle). */
export function setWorkspaceProvider(fn: () => string): void {
  wsProvider = fn;
}

/**
 * Appends `?ws=<id>` (or `&ws=`) to a workspace-scoped path using the given id,
 * or the active workspace when `ws` is undefined. An empty id is omitted so
 * the server falls back to its default workspace (back-compat).
 */
export function withWorkspace(path: string, ws?: string): string {
  const id = ws ?? wsProvider();
  if (!id) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}ws=${encodeURIComponent(id)}`;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function abortError(): Error {
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  if (isMock()) {
    try {
      // Loaded lazily so the dev-only mock + fixtures stay out of the prod bundle.
      const { mockRequest } = await import("../mock/api");
      const result = (await mockRequest(method, path, body)) as T;
      if (signal?.aborted) throw abortError();
      return result;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") throw e;
      // mock errors carry {code, status} props; normalize to ApiError so
      // views can branch on status (e.g. rewind 404) like with the server.
      const err = e as { code?: string; status?: number; message?: string };
      throw new ApiError(err.code ?? "mock_error", err.message ?? String(e), err.status ?? 500);
    }
  }

  const headers: Record<string, string> = { Authorization: `Bearer ${tokenProvider()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    let code = "http_error";
    let message = `${res.status} ${res.statusText}`;
    try {
      const payload = (await res.json()) as { error?: { code?: string; message?: string } };
      if (payload.error?.code) code = payload.error.code;
      if (payload.error?.message) message = payload.error.message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(code, message, res.status);
  }
  return (await res.json()) as T;
}

/**
 * A 1x1 transparent PNG, used as the mock-mode placeholder for rawUrl so the
 * UI renders an <img> (which then falls back to the styled chip via onError,
 * or simply shows nothing visible) instead of pointing at a real server route.
 */
const MOCK_RAW_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const api = {
  // Global (not workspace-scoped).
  // Normalizes the response so an older server (which returned a bare array) is
  // tolerated as {workspaces, recents:[]} rather than crashing the boot loader
  // and tripping the false "server unreachable" banner.
  workspaces: async (): Promise<WorkspacesResponse> => {
    const res = await request<WorkspacesResponse | Workspace[]>("GET", "/api/workspaces");
    return Array.isArray(res)
      ? { workspaces: res, recents: [] }
      : { workspaces: res.workspaces ?? [], recents: res.recents ?? [] };
  },
  /** Open a folder as a workspace: registers it (idempotent) and remembers it. */
  openWorkspace: (path: string) =>
    request<{ workspace: Workspace } & WorkspacesResponse>("POST", "/api/workspaces", { path }),
  /** Stop hosting a workspace (the launch/default workspace cannot be removed). */
  unhostWorkspace: (id: string) => request<WorkspacesResponse>("DELETE", `/api/workspaces/${encodeURIComponent(id)}`),
  /** Forget a recent path (does not affect hosting). */
  forgetRecent: (path: string) =>
    request<WorkspacesResponse>("DELETE", `/api/workspaces/recent?path=${encodeURIComponent(path)}`),

  /**
   * URL that serves the raw bytes of an uploaded image (GET /api/raw), for use
   * as an `<img src>`. Carries `?ws=` (the tab's workspace, or `ws` override)
   * and the auth token in the query string — an `<img>` request cannot send an
   * Authorization header. In mock mode returns a data-URL placeholder so the
   * mock UI never points at a real route.
   */
  rawUrl: (path: string, ws?: string): string => {
    if (isMock()) return MOCK_RAW_DATA_URL;
    const url = withWorkspace(`/api/raw?path=${encodeURIComponent(path)}`, ws);
    const token = tokenProvider();
    return token ? `${url}&token=${encodeURIComponent(token)}` : url;
  },

  // Workspace-scoped: `?ws=<active>` is appended centrally via withWorkspace.
  sessions: (ws?: string) => request<SessionMeta[]>("GET", withWorkspace("/api/sessions", ws)),
  session: (id: string, ws?: string) =>
    request<{ meta: SessionMeta; messages: ChatMessage[]; events: AgentEvent[] }>(
      "GET",
      withWorkspace(`/api/sessions/${encodeURIComponent(id)}`, ws),
    ),
  skills: (ws?: string) => request<Skill[]>("GET", withWorkspace("/api/skills", ws)),
  skill: (id: string, ws?: string) => request<Skill>("GET", withWorkspace(`/api/skills/${encodeURIComponent(id)}`, ws)),
  memory: (ws?: string) => request<MemoryResponse>("GET", withWorkspace("/api/memory", ws)),
  memoryAction: (id: string, action: "approve" | "reject", scope?: "project" | "user", ws?: string) =>
    request<MemoryCandidate>(
      "POST",
      withWorkspace(`/api/memory/${encodeURIComponent(id)}/${action}${scope === "user" ? "?scope=user" : ""}`, ws),
    ),
  memoryAddFact: (
    content: string,
    type: MemoryCandidateType,
    pending?: boolean,
    scope?: "project" | "user",
    ws?: string,
  ) =>
    request<MemoryCandidate>("POST", withWorkspace("/api/memory/fact", ws), {
      content,
      type,
      ...(pending ? { pending: true } : {}),
      ...(scope === "user" ? { scope: "user" } : {}),
    }),
  memoryDeleteFact: (selector: { index: number } | { match: string }, ws?: string) =>
    request<{ removed: string }>("DELETE", withWorkspace("/api/memory/fact", ws), selector),
  diff: (staged?: boolean, ws?: string) =>
    request<{ diff: string; truncated: boolean; notGit?: boolean }>(
      "GET",
      withWorkspace(`/api/diff${staged ? "?staged=1" : ""}`, ws),
    ),
  config: (ws?: string) => request<ServerConfig>("GET", withWorkspace("/api/config", ws)),
  setConfig: (key: ConfigKey, value: string, global?: boolean, ws?: string) =>
    request<ServerConfig>("PUT", withWorkspace("/api/config", ws), {
      key,
      value,
      ...(global ? { global: true } : {}),
    }),
  agents: (ws?: string) => request<AgentInfo[]>("GET", withWorkspace("/api/agents", ws)),
  agent: (id: string, ws?: string) =>
    request<AgentInfo>("GET", withWorkspace(`/api/agents/${encodeURIComponent(id)}`, ws)),
  evolution: (ws?: string) => request<EvolutionProposal[]>("GET", withWorkspace("/api/evolution", ws)),
  evolutionAction: (id: string, action: "accept" | "reject", ws?: string) =>
    request<EvolutionProposal>("POST", withWorkspace(`/api/evolution/${encodeURIComponent(id)}/${action}`, ws)),
  evolutionApply: (id: string, ws?: string) =>
    request<{ proposal: EvolutionProposal; changedPath: string }>(
      "POST",
      withWorkspace(`/api/evolution/${encodeURIComponent(id)}/apply`, ws),
    ),
  mcp: (ws?: string) => request<McpServer[]>("GET", withWorkspace("/api/mcp", ws)),
  mcpTools: (name: string, ws?: string) =>
    request<{ tools: McpTool[] }>("POST", withWorkspace(`/api/mcp/${encodeURIComponent(name)}/tools`, ws)).then(
      (result) => result.tools,
    ),
  // Worktree sessions. Create/list are scoped to the base workspace via `ws`;
  // merge/delete identify the worktree by id (any valid `ws` works, so we pass
  // the worktree's own workspace id — the server resolves the base itself).
  worktreeCreate: (ws: string, name?: string) =>
    request<WorktreeCreated>("POST", withWorkspace("/api/worktrees", ws), name ? { name } : {}),
  worktrees: (ws: string) => request<WorktreeStatus[]>("GET", withWorkspace("/api/worktrees", ws)),
  worktreeMerge: (id: string) =>
    request<WorktreeMergeResult>("POST", withWorkspace(`/api/worktrees/${encodeURIComponent(id)}/merge`, id)),
  worktreeDelete: (id: string) =>
    request<{ deleted: true }>("DELETE", withWorkspace(`/api/worktrees/${encodeURIComponent(id)}`, id)),
  rewind: (sessionId: string, dryRun?: boolean, ws?: string) =>
    request<RewindResult>("POST", withWorkspace("/api/rewind", ws), {
      sessionId,
      ...(dryRun ? { dryRun: true } : {}),
    }),
  // Composer: @ file picker index and image paste/drop uploads. Both take an
  // explicit ws so a tab bound to a non-active workspace still hits the right
  // one (an empty/omitted id resolves to the server's default workspace,
  // matching the tab's WS frame semantics).
  searchContent: (q: string, opts?: { caseSensitive?: boolean; regex?: boolean }, ws?: string) => {
    const params = new URLSearchParams({ q });
    if (opts?.caseSensitive) params.set("case", "1");
    if (opts?.regex) params.set("regex", "1");
    return request<SearchResult>("GET", withWorkspace(`/api/search?${params.toString()}`, ws));
  },
  files: (q: string, ws?: string) =>
    request<{ files: string[]; truncated: boolean }>(
      "GET",
      withWorkspace(`/api/files${q ? `?q=${encodeURIComponent(q)}` : ""}`, ws),
    ),
  upload: (name: string, dataBase64: string, ws?: string) =>
    request<{ path: string }>("POST", withWorkspace("/api/upload", ws), { name, dataBase64 }),
  // `ws` overrides the active workspace where a tab is bound to another one.
  sessionTurns: (id: string, ws?: string) =>
    request<SessionTurn[]>("GET", withWorkspace(`/api/sessions/${encodeURIComponent(id)}/turns`, ws)),
  backtrack: (id: string, turn: number, files: boolean, ws?: string) =>
    request<BacktrackResult>("POST", withWorkspace(`/api/sessions/${encodeURIComponent(id)}/backtrack`, ws), {
      turn,
      files,
    }),
  todos: (ws?: string) => request<Todo[]>("GET", withWorkspace("/api/todos", ws)),
  /** Every mutation returns the updated todo list. */
  todosOp: (op: { op: "add"; text: string } | { op: "toggle" | "remove"; index: number }, ws?: string) =>
    request<Todo[]>("POST", withWorkspace("/api/todos", ws), op),
  balance: (ws?: string) => request<{ balance: AccountBalance | null }>("GET", withWorkspace("/api/balance", ws)),
  verifyProvider: (apiKey: string) =>
    request<{ ok: true } | { ok: false; reason: "invalid_credentials" | "provider_error" | "unreachable" }>(
      "POST",
      "/api/provider/verify",
      { apiKey },
    ),
  mcpResources: (ws?: string) => request<{ resources: McpResource[] }>("GET", withWorkspace("/api/mcp/resources", ws)),
  mcpPrompts: (ws?: string) => request<{ prompts: McpPrompt[] }>("GET", withWorkspace("/api/mcp/prompts", ws)),
  mcpPrompt: (server: string, name: string, args: Record<string, unknown> = {}, ws?: string, signal?: AbortSignal) =>
    request<{ text: string }>(
      "POST",
      withWorkspace(`/api/mcp/prompts/${encodeURIComponent(server)}/${encodeURIComponent(name)}`, ws),
      { arguments: args },
      signal,
    ),
  models: () => request<ModelInfo[]>("GET", "/api/models"),

  // Memory stats + compaction (workspace-scoped).
  memoryStats: (ws?: string) => request<MemoryStats>("GET", withWorkspace("/api/memory/stats", ws)),
  memoryCompact: (opts?: { dryRun?: boolean; pruneUnusedDays?: number }, ws?: string) =>
    request<CompactResult>("POST", withWorkspace("/api/memory/compact", ws), opts ?? {}),

  // Skills lifecycle (workspace-scoped). Builtin skills are read-only.
  skillSetEnabled: (id: string, enabled: boolean, scope?: SkillScope, ws?: string) =>
    request<Skill>("PUT", withWorkspace(`/api/skills/${encodeURIComponent(id)}`, ws), {
      enabled,
      ...(scope ? { scope } : {}),
    }),
  skillCreate: (id: string, ws?: string) => request<Skill>("POST", withWorkspace("/api/skills", ws), { id }),
  skillImport: (path: string, global?: boolean, ws?: string) =>
    request<Skill>("POST", withWorkspace("/api/skills/import", ws), { path, ...(global ? { global: true } : {}) }),
  skillDelete: (id: string, scope?: SkillScope, ws?: string) =>
    request<{ deleted: boolean }>(
      "DELETE",
      withWorkspace(`/api/skills/${encodeURIComponent(id)}${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, ws),
    ),

  // Sessions lifecycle (workspace-scoped).
  sessionDelete: (id: string, ws?: string) =>
    request<{ deleted: boolean }>("DELETE", withWorkspace(`/api/sessions/${encodeURIComponent(id)}`, ws)),
  sessionsPrune: (opts?: { olderThanDays?: number; keepLast?: number; dryRun?: boolean }, ws?: string) =>
    request<PruneResult>("POST", withWorkspace("/api/sessions/prune", ws), opts ?? {}),

  // Agents import (workspace-scoped).
  agentImport: (path: string, global?: boolean, ws?: string) =>
    request<AgentImportResult>("POST", withWorkspace("/api/agents/import", ws), {
      path,
      ...(global ? { global: true } : {}),
    }),

  // MCP server management (workspace-scoped).
  mcpAdd: (
    cfg: {
      name: string;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      oauth?: {
        tokenEndpoint: string;
        clientId: string;
        clientSecret?: string;
        refreshToken: string;
        scope?: string;
      };
      trusted?: boolean;
      scope?: McpScope;
    },
    ws?: string,
  ) => request<{ ok: true; server: McpServer }>("POST", withWorkspace("/api/mcp", ws), cfg),
  mcpRemove: (name: string, scope: McpScope, ws?: string) =>
    request<{ ok: true; scope: McpScope }>(
      "DELETE",
      withWorkspace(`/api/mcp/${encodeURIComponent(name)}?scope=${encodeURIComponent(scope)}`, ws),
    ),
  mcpTest: (name: string, ws?: string) =>
    request<{ ok: true; latencyMs: number; toolCount: number }>(
      "POST",
      withWorkspace(`/api/mcp/${encodeURIComponent(name)}/test`, ws),
    ),

  // Security Center (workspace-scoped).
  security: (ws?: string) => request<SecurityEvidencePackage>("GET", withWorkspace("/api/security", ws)),
  securityScan: (maxFindings = 50, ws?: string) =>
    request<{ scan: SecurityEvidencePackage["scans"][number]; findings: SecurityFinding[] }>(
      "POST",
      withWorkspace("/api/security/scan", ws),
      { maxFindings },
    ),
  securityFindingStatus: (id: string, status: SecurityFinding["status"], reason: string, ws?: string) =>
    request<SecurityFinding>("POST", withWorkspace(`/api/security/findings/${encodeURIComponent(id)}/status`, ws), {
      status,
      reason,
    }),
  securityFix: (id: string, maxCostUsd: number, verifyCommand: string, lintCommand?: string, ws?: string) =>
    request<{ fix: SecurityFix; finding?: SecurityFinding }>(
      "POST",
      withWorkspace(`/api/security/findings/${encodeURIComponent(id)}/fix`, ws),
      { maxCostUsd, verifyCommand, ...(lintCommand?.trim() ? { lintCommand } : {}) },
    ),
  securityThreatModel: (ws?: string) => request<ThreatModel>("POST", withWorkspace("/api/security/threat-model", ws)),
  securityExport: (format: "json" | "markdown" | "sarif", ws?: string) =>
    request<{ format: string; filename: string; content: string; disclaimer: string }>(
      "GET",
      withWorkspace(`/api/security/export?format=${format}`, ws),
    ),

  // Environment diagnostics (workspace-scoped).
  doctor: (ws?: string) => request<DoctorReport>("GET", withWorkspace("/api/doctor", ws)),

  // Files browser + editor (workspace-scoped). `path` is workspace-relative.
  tree: (path?: string, ws?: string) =>
    request<TreeResponse>("GET", withWorkspace(`/api/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`, ws)),
  readFile: (path: string, ws?: string) =>
    request<FileContent>("GET", withWorkspace(`/api/file?path=${encodeURIComponent(path)}`, ws)),
  writeFile: (path: string, content: string, ws?: string) =>
    request<{ ok: true }>("PUT", withWorkspace("/api/file", ws), { path, content }),

  // Source control (workspace-scoped).
  gitStatus: (ws?: string) => request<GitStatus>("GET", withWorkspace("/api/git/status", ws)),
  gitStage: (paths: string[], ws?: string) =>
    request<{ ok: boolean }>("POST", withWorkspace("/api/git/stage", ws), { paths }),
  gitUnstage: (paths: string[], ws?: string) =>
    request<{ ok: boolean }>("POST", withWorkspace("/api/git/unstage", ws), { paths }),
  gitDiscard: (paths: string[], ws?: string) =>
    request<{ ok: boolean }>("POST", withWorkspace("/api/git/discard", ws), { paths }),
  gitCommit: (message: string, ws?: string) =>
    request<{ ok: boolean; commit: string }>("POST", withWorkspace("/api/git/commit", ws), { message }),

  // Custom slash commands surfaced in the composer (workspace-scoped).
  commands: (ws?: string) => request<CommandsResponse>("GET", withWorkspace("/api/commands", ws)),
  /** Server-side expand: interpolates args and runs !`shell` injections in the workspace. */
  expandCommand: (name: string, args: string, ws?: string) =>
    request<{ text: string }>("POST", withWorkspace("/api/commands/expand", ws), { name, args }),
  /** Available output styles (built-ins + custom .seekforge/output-styles/*.md). */
  outputStyles: (ws?: string) =>
    request<{ styles: { name: string; kind: "builtin" | "custom" }[] }>("GET", withWorkspace("/api/output-styles", ws)),
  /** Project hooks config (the editable .seekforge/config.json layer). */
  hooks: (ws?: string) => request<{ hooks: HooksConfig }>("GET", withWorkspace("/api/hooks", ws)),
  saveHooks: (hooks: HooksConfig, ws?: string) =>
    request<{ hooks: HooksConfig }>("PUT", withWorkspace("/api/hooks", ws), { hooks }),

  // Manual session compaction (workspace-scoped). Result is treated as opaque.
  sessionCompact: (id: string, ws?: string) =>
    request<unknown>("POST", withWorkspace(`/api/sessions/${encodeURIComponent(id)}/compact`, ws)),

  // Fork a session into a NEW session id (the original is untouched); returns
  // the new id so the caller can open the forked copy (workspace-scoped).
  forkSession: (id: string, ws?: string) =>
    request<{ id: string }>("POST", withWorkspace(`/api/sessions/${encodeURIComponent(id)}/fork`, ws)),

  // Reviewable session audit (workspace-scoped): a rendered markdown timeline plus
  // the structured audit payload (treated as opaque). 404 for an unknown id.
  sessionAudit: (id: string, ws?: string) =>
    request<{ markdown: string; audit: unknown }>(
      "GET",
      withWorkspace(`/api/sessions/${encodeURIComponent(id)}/audit`, ws),
    ),
};
