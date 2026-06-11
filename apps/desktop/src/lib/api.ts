/** REST client per SERVER-API.md; attaches Authorization: Bearer <token>. */
import type { ChatMessage } from "@seekforge/shared";
import { isMock } from "../mock";
import { mockRequest } from "../mock/api";
import type {
  ConfigKey,
  MemoryCandidate,
  MemoryResponse,
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
  if (isMock()) return (await mockRequest(method, path, body)) as T;

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
  config: () => request<ServerConfig>("GET", "/api/config"),
  setConfig: (key: ConfigKey, value: string, global?: boolean) =>
    request<ServerConfig>("PUT", "/api/config", { key, value, ...(global ? { global: true } : {}) }),
};
