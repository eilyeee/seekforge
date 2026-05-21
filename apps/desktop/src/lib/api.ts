/** REST client per SERVER-API.md; attaches Authorization: Bearer <token>. */
import type { ChatMessage } from "@seekforge/shared";
import { isMock } from "../mock";
import { mockRequest } from "../mock/api";
import type {
  AccountBalance,
  AgentInfo,
  BacktrackResult,
  ConfigKey,
  EvolutionProposal,
  McpResource,
  McpServer,
  McpTool,
  MemoryCandidate,
  MemoryResponse,
  RewindResult,
  ServerConfig,
  SessionMeta,
  SessionTurn,
  Skill,
  Todo,
  Workspace,
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

async function request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  if (isMock()) {
    try {
      return (await mockRequest(method, path, body)) as T;
    } catch (e) {
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
  workspaces: () => request<Workspace[]>("GET", "/api/workspaces"),

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
  sessions: () => request<SessionMeta[]>("GET", withWorkspace("/api/sessions")),
  session: (id: string) =>
    request<{ meta: SessionMeta; messages: ChatMessage[] }>(
      "GET",
      withWorkspace(`/api/sessions/${encodeURIComponent(id)}`),
    ),
  skills: () => request<Skill[]>("GET", withWorkspace("/api/skills")),
  skill: (id: string) => request<Skill>("GET", withWorkspace(`/api/skills/${encodeURIComponent(id)}`)),
  memory: () => request<MemoryResponse>("GET", withWorkspace("/api/memory")),
  memoryAction: (id: string, action: "approve" | "reject") =>
    request<MemoryCandidate>("POST", withWorkspace(`/api/memory/${encodeURIComponent(id)}/${action}`)),
  diff: (staged?: boolean) =>
    request<{ diff: string; truncated: boolean }>("GET", withWorkspace(`/api/diff${staged ? "?staged=1" : ""}`)),
  config: () => request<ServerConfig>("GET", withWorkspace("/api/config")),
  setConfig: (key: ConfigKey, value: string, global?: boolean) =>
    request<ServerConfig>("PUT", withWorkspace("/api/config"), {
      key,
      value,
      ...(global ? { global: true } : {}),
    }),
  agents: () => request<AgentInfo[]>("GET", withWorkspace("/api/agents")),
  agent: (id: string) => request<AgentInfo>("GET", withWorkspace(`/api/agents/${encodeURIComponent(id)}`)),
  evolution: () => request<EvolutionProposal[]>("GET", withWorkspace("/api/evolution")),
  evolutionAction: (id: string, action: "accept" | "reject") =>
    request<EvolutionProposal>("POST", withWorkspace(`/api/evolution/${encodeURIComponent(id)}/${action}`)),
  evolutionApply: (id: string) =>
    request<{ proposal: EvolutionProposal; changedPath: string }>(
      "POST",
      withWorkspace(`/api/evolution/${encodeURIComponent(id)}/apply`),
    ),
  mcp: () => request<McpServer[]>("GET", withWorkspace("/api/mcp")),
  mcpTools: (name: string) =>
    request<McpTool[]>("POST", withWorkspace(`/api/mcp/${encodeURIComponent(name)}/tools`)),
  // Worktree sessions. Create/list are scoped to the base workspace via `ws`;
  // merge/delete identify the worktree by id (any valid `ws` works, so we pass
  // the worktree's own workspace id — the server resolves the base itself).
  worktreeCreate: (ws: string, name?: string) =>
    request<WorktreeCreated>("POST", withWorkspace("/api/worktrees", ws), name ? { name } : {}),
  worktrees: (ws: string) => request<WorktreeStatus[]>("GET", withWorkspace("/api/worktrees", ws)),
  worktreeMerge: (id: string) =>
    request<WorktreeMergeResult>(
      "POST",
      withWorkspace(`/api/worktrees/${encodeURIComponent(id)}/merge`, id),
    ),
  worktreeDelete: (id: string) =>
    request<{ deleted: true }>("DELETE", withWorkspace(`/api/worktrees/${encodeURIComponent(id)}`, id)),
  rewind: (sessionId: string, dryRun?: boolean) =>
    request<RewindResult>("POST", withWorkspace("/api/rewind"), {
      sessionId,
      ...(dryRun ? { dryRun: true } : {}),
    }),
  // Composer: @ file picker index and image paste/drop uploads. Both take an
  // explicit ws so a tab bound to a non-active workspace still hits the right
  // one (an empty/omitted id resolves to the server's default workspace,
  // matching the tab's WS frame semantics).
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
  todos: () => request<Todo[]>("GET", withWorkspace("/api/todos")),
  /** Every mutation returns the updated todo list. */
  todosOp: (op: { op: "add"; text: string } | { op: "toggle" | "remove"; index: number }) =>
    request<Todo[]>("POST", withWorkspace("/api/todos"), op),
  balance: () => request<{ balance: AccountBalance | null }>("GET", withWorkspace("/api/balance")),
  mcpResources: () => request<{ resources: McpResource[] }>("GET", withWorkspace("/api/mcp/resources")),
};
