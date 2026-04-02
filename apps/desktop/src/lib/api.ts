/** REST client per SERVER-API.md; attaches Authorization: Bearer <token>. */
import type { ChatMessage } from "@seekforge/shared";
import { isMock } from "../mock";
import { mockRequest } from "../mock/api";
import type {
  AgentInfo,
  ConfigKey,
  EvolutionProposal,
  McpServer,
  McpTool,
  MemoryCandidate,
  MemoryResponse,
  RewindResult,
  ServerConfig,
  SessionMeta,
  Skill,
} from "../types";

let tokenProvider: () => string = () => "";

/** Wired up by the store at boot (avoids an import cycle). */
export function setTokenProvider(fn: () => string): void {
  tokenProvider = fn;
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

async function request<T>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
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

export const api = {
  sessions: () => request<SessionMeta[]>("GET", "/api/sessions"),
  session: (id: string) =>
    request<{ meta: SessionMeta; messages: ChatMessage[] }>("GET", `/api/sessions/${encodeURIComponent(id)}`),
  skills: () => request<Skill[]>("GET", "/api/skills"),
  skill: (id: string) => request<Skill>("GET", `/api/skills/${encodeURIComponent(id)}`),
  memory: () => request<MemoryResponse>("GET", "/api/memory"),
  memoryAction: (id: string, action: "approve" | "reject") =>
    request<MemoryCandidate>("POST", `/api/memory/${encodeURIComponent(id)}/${action}`),
  diff: (staged?: boolean) =>
    request<{ diff: string; truncated: boolean }>("GET", `/api/diff${staged ? "?staged=1" : ""}`),
  config: () => request<ServerConfig>("GET", "/api/config"),
  setConfig: (key: ConfigKey, value: string, global?: boolean) =>
    request<ServerConfig>("PUT", "/api/config", { key, value, ...(global ? { global: true } : {}) }),
  agents: () => request<AgentInfo[]>("GET", "/api/agents"),
  agent: (id: string) => request<AgentInfo>("GET", `/api/agents/${encodeURIComponent(id)}`),
  evolution: () => request<EvolutionProposal[]>("GET", "/api/evolution"),
  evolutionAction: (id: string, action: "accept" | "reject") =>
    request<EvolutionProposal>("POST", `/api/evolution/${encodeURIComponent(id)}/${action}`),
  evolutionApply: (id: string) =>
    request<{ proposal: EvolutionProposal; changedPath: string }>(
      "POST",
      `/api/evolution/${encodeURIComponent(id)}/apply`,
    ),
  mcp: () => request<McpServer[]>("GET", "/api/mcp"),
  mcpTools: (name: string) => request<McpTool[]>("POST", `/api/mcp/${encodeURIComponent(name)}/tools`),
  rewind: (sessionId: string, dryRun?: boolean) =>
    request<RewindResult>("POST", "/api/rewind", { sessionId, ...(dryRun ? { dryRun: true } : {}) }),
};
