/** Mock REST backend: same paths/shapes as SERVER-API.md. */
import {
  mockCandidates,
  mockConfig,
  mockProjectMd,
  mockSessionMessages,
  mockSessions,
  mockSkillContent,
  mockSkills,
} from "./fixtures";
import type { MemoryCandidate, ServerConfig } from "../types";

// Mutable copies so approve/reject and config saves stick for the page lifetime.
const candidates: MemoryCandidate[] = mockCandidates.map((c) => ({ ...c }));
const config: ServerConfig = { ...mockConfig, commandAllowlist: [...(mockConfig.commandAllowlist ?? [])] };

function delay(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mockRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  await delay();

  if (method === "GET" && path === "/api/health") return { version: "0.2.0-mock", workspace: "/mock/workspace" };
  if (method === "GET" && path === "/api/sessions") return mockSessions;

  let m = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const meta = mockSessions.find((s) => s.id === m![1]);
    if (!meta) throw new Error("session not found");
    return { meta, messages: mockSessionMessages[meta.id] ?? [] };
  }

  if (method === "GET" && path === "/api/skills") return mockSkills;
  m = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const skill = mockSkills.find((s) => s.id === m![1]);
    if (!skill) throw new Error("skill not found");
    return { ...skill, content: mockSkillContent[skill.id] ?? "" };
  }

  if (method === "GET" && path === "/api/memory") return { projectMd: mockProjectMd, candidates };
  m = /^\/api\/memory\/([^/]+)\/(approve|reject)$/.exec(path);
  if (method === "POST" && m) {
    const candidate = candidates.find((c) => c.id === m![1]);
    if (!candidate) throw new Error("candidate not found");
    candidate.status = m[2] === "approve" ? "approved" : "rejected";
    return { ...candidate };
  }

  if (method === "GET" && path === "/api/config") return { ...config };
  if (method === "PUT" && path === "/api/config") {
    const { key, value } = (body ?? {}) as { key?: string; value?: unknown };
    // Accept known keys only, mirroring the server's validation (400 on unknown).
    switch (key) {
      case "model":
      case "baseUrl":
      case "runtimeBin":
        config[key] = String(value);
        break;
      case "apiKey":
        config.apiKey = `${String(value).slice(0, 6)}****`;
        break;
      case "commandAllowlist":
        config.commandAllowlist = String(value)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      default:
        throw new Error(`unknown config key: ${String(key)}`);
    }
    return { ...config };
  }

  throw new Error(`mock: unhandled ${method} ${path}`);
}
