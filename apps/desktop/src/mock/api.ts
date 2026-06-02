/** Mock REST backend: same paths/shapes as SERVER-API.md. */
import {
  mockAgents,
  mockCandidates,
  mockConfig,
  mockEvolutionProposals,
  mockFacts,
  mockMcpServers,
  mockMcpTools,
  mockModels,
  mockProjectMd,
  mockRewindResults,
  mockSessionMessages,
  mockSessions,
  mockSkillContent,
  mockSkills,
} from "./fixtures";
import type {
  EvolutionProposal,
  MemoryCandidate,
  MemoryCandidateType,
  MemoryFact,
  ServerConfig,
  Todo,
} from "../types";

// Mutable copies so approve/reject and config saves stick for the page lifetime.
const candidates: MemoryCandidate[] = mockCandidates.map((c) => ({ ...c }));
const facts: MemoryFact[] = mockFacts.map((f) => ({ ...f }));
const config: ServerConfig = { ...mockConfig, commandAllowlist: [...(mockConfig.commandAllowlist ?? [])] };
const proposals: EvolutionProposal[] = mockEvolutionProposals.map((p) => ({ ...p }));
const todos: Todo[] = [
  { index: 1, text: "ship the v11 capability UI", done: false },
  { index: 2, text: "rerun the eval baseline", done: true },
];

function delay(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error shaped like the server's {error:{code,message}} after api.ts normalization. */
function mockError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

/** Two mock workspaces so the switcher is exercisable in mock mode. */
const mockWorkspaces = [
  { id: "mockws1", name: "workspace", path: "/mock/workspace" },
  { id: "mockws2", name: "other-project", path: "/mock/other-project" },
];

/** Fixture file index for the composer's @ picker. */
const mockWorkspaceFiles = [
  "package.json",
  "README.md",
  "src/app.ts",
  "src/index.css",
  "src/components/Button.tsx",
  "src/components/Modal.tsx",
  "src/lib/api.ts",
  "src/lib/utils.ts",
  "tests/app.test.ts",
];

let uploadCounter = 0;

/** In-memory worktree sessions (mock of the git-backed real server). */
type MockWorktree = { id: string; branch: string; path: string; dirty: boolean; ahead: number };
const mockWorktrees: MockWorktree[] = [];
let mockWorktreeSeq = 0;

export async function mockRequest(method: string, fullPath: string, body?: unknown): Promise<unknown> {
  await delay();

  // The real server scopes routes by ?ws=; the mock serves the same fixtures
  // for every workspace, so strip the query and match on the bare path.
  const path = fullPath.split("?")[0]!;

  if (method === "GET" && path === "/api/models") return mockModels.map((m) => ({ ...m }));

  if (method === "GET" && path === "/api/workspaces")
    return [...mockWorkspaces, ...mockWorktrees.map((w) => ({ id: w.id, name: w.branch.split("/")[1]!, path: w.path }))];

  if (method === "GET" && path === "/api/worktrees") return mockWorktrees.map((w) => ({ ...w }));
  if (method === "POST" && path === "/api/worktrees") {
    const { name } = (body ?? {}) as { name?: string };
    const slug = (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `session-${++mockWorktreeSeq}`;
    const wt: MockWorktree = {
      id: `wt-${slug}`,
      branch: `seekforge/${slug}`,
      path: `/mock/workspace/.seekforge/worktrees/${slug}`,
      dirty: false,
      ahead: 0,
    };
    mockWorktrees.push(wt);
    return { id: wt.id, path: wt.path, branch: wt.branch };
  }
  let wtm = /^\/api\/worktrees\/([^/]+)\/merge$/.exec(path);
  if (method === "POST" && wtm) {
    const wt = mockWorktrees.find((w) => w.id === wtm![1]);
    if (!wt) throw mockError(404, "not_found", `unknown worktree: ${wtm[1]}`);
    // A worktree named "conflict" exercises the conflict UI in mock mode.
    if (wt.id.includes("conflict")) return { conflict: true, files: ["src/app.ts", "README.md"] };
    wt.dirty = false;
    wt.ahead = 0;
    return { merged: true };
  }
  wtm = /^\/api\/worktrees\/([^/]+)$/.exec(path);
  if (method === "DELETE" && wtm) {
    const idx = mockWorktrees.findIndex((w) => w.id === wtm![1]);
    if (idx < 0) throw mockError(404, "not_found", `unknown worktree: ${wtm[1]}`);
    mockWorktrees.splice(idx, 1);
    return { deleted: true };
  }
  if (method === "GET" && path === "/api/health")
    return { version: "0.2.0-mock", workspace: "/mock/workspace", workspaces: mockWorkspaces };
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

  if (method === "GET" && path.startsWith("/api/diff")) {
    return {
      diff: [
        "diff --git a/src/app.ts b/src/app.ts",
        "index 1111111..2222222 100644",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,4 +1,4 @@",
        '-const title = "Old";',
        '+const title = "New";',
        " export function render() {",
        "   return title;",
        " }",
      ].join("\n"),
      truncated: false,
    };
  }

  if (method === "GET" && path === "/api/memory") {
    return { projectMd: mockProjectMd, candidates, facts: facts.map((f) => ({ ...f })) };
  }
  if (method === "POST" && path === "/api/memory/fact") {
    const { content, type, pending } = (body ?? {}) as {
      content?: unknown;
      type?: unknown;
      pending?: unknown;
    };
    if (typeof content !== "string" || content.trim() === "") {
      throw mockError(400, "bad_request", "content must be a non-empty string");
    }
    const factType = (typeof type === "string" ? type : "convention") as MemoryCandidateType;
    if (!pending) {
      facts.push({
        index: facts.length + 1,
        type: factType,
        content: content.trim(),
        addedAt: new Date().toISOString(),
        uses: 0,
      });
    }
    return {
      id: `mc-user-${Date.now()}`,
      content: content.trim(),
      type: factType,
      confidence: 1,
      sourceSessionId: "manual",
      createdAt: new Date().toISOString(),
      status: pending ? "pending" : "approved",
    };
  }
  if (method === "DELETE" && path === "/api/memory/fact") {
    const { index, match } = (body ?? {}) as { index?: unknown; match?: unknown };
    let pos = -1;
    if (typeof index === "number") {
      pos = facts.findIndex((f) => f.index === index);
    } else if (typeof match === "string" && match.trim() !== "") {
      pos = facts.findIndex((f) => f.content.includes(match));
    } else {
      throw mockError(400, "bad_request", "provide exactly one of: index or match");
    }
    if (pos === -1) throw mockError(400, "bad_request", "no matching fact");
    const [removed] = facts.splice(pos, 1);
    // Renumber so 1-based indexes stay contiguous, mirroring the server.
    facts.forEach((f, i) => (f.index = i + 1));
    return { removed: `- [${removed!.type}] ${removed!.content}` };
  }
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

  if (method === "GET" && path === "/api/agents") {
    // List omits the prompt body, like the real server.
    return mockAgents.map(({ body: _body, ...rest }) => rest);
  }
  m = /^\/api\/agents\/([^/]+)$/.exec(path);
  if (method === "GET" && m) {
    const agent = mockAgents.find((a) => a.id === m![1]);
    if (!agent) throw mockError(404, "not_found", "agent not found");
    return { ...agent };
  }

  if (method === "GET" && path === "/api/evolution") {
    // Pending first, like the real server.
    return [...proposals].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  }
  m = /^\/api\/evolution\/([^/]+)\/(accept|reject|apply)$/.exec(path);
  if (method === "POST" && m) {
    const proposal = proposals.find((p) => p.id === m![1]);
    if (!proposal) throw mockError(404, "not_found", "proposal not found");
    const action = m[2] as "accept" | "reject" | "apply";
    if (action === "apply") {
      if (proposal.status !== "accepted") throw mockError(409, "invalid_status", "proposal must be accepted first");
      proposal.status = "applied";
      proposal.reviewedAt = new Date().toISOString();
      const changedPath =
        proposal.type === "skill"
          ? `.seekforge/skills/${proposal.proposal.skillId ?? proposal.id}/SKILL.md`
          : ".seekforge/PROJECT.md";
      return { proposal: { ...proposal }, changedPath };
    }
    if (proposal.status !== "pending") throw mockError(409, "invalid_status", "proposal already reviewed");
    proposal.status = action === "accept" ? "accepted" : "rejected";
    proposal.reviewedAt = new Date().toISOString();
    return { ...proposal };
  }

  // User-turn index: all role:"user" messages of the stored transcript.
  m = /^\/api\/sessions\/([^/]+)\/turns$/.exec(path);
  if (method === "GET" && m) {
    const messages = mockSessionMessages[decodeURIComponent(m[1]!)];
    if (!messages) throw mockError(404, "not_found", "session not found");
    return messages
      .filter((msg) => msg.role === "user")
      .map((msg, turn) => ({ turn, text: msg.content, backtrackable: turn > 0 }));
  }

  m = /^\/api\/sessions\/([^/]+)\/backtrack$/.exec(path);
  if (method === "POST" && m) {
    const messages = mockSessionMessages[decodeURIComponent(m[1]!)];
    if (!messages) throw mockError(404, "not_found", "session not found");
    const { turn, files } = (body ?? {}) as { turn?: number; files?: boolean };
    let userTurn = -1;
    let cutAt = -1;
    for (let i = 0; i < messages.length; i += 1) {
      if (messages[i]!.role !== "user") continue;
      userTurn += 1;
      if (userTurn === turn) {
        cutAt = i;
        break;
      }
    }
    if (typeof turn !== "number" || turn <= 0 || cutAt < 0) {
      throw mockError(400, "bad_request", `turn ${String(turn)} is not backtrackable`);
    }
    messages.splice(cutAt); // mock truncation sticks for the page lifetime
    return {
      removedMessages: 0,
      keptMessages: messages.length,
      files: files ? { restored: 1, deleted: 0, skipped: 0 } : null,
    };
  }

  if (method === "GET" && path === "/api/todos") return todos.map((t) => ({ ...t }));
  if (method === "POST" && path === "/api/todos") {
    const { op, text, index } = (body ?? {}) as { op?: string; text?: string; index?: number };
    if (op === "add" && text?.trim()) {
      todos.push({ index: todos.length + 1, text: text.trim(), done: false });
    } else if (op === "toggle" || op === "remove") {
      const at = todos.findIndex((t) => t.index === index);
      if (at < 0) throw mockError(404, "not_found", `no todo at index ${String(index)}`);
      if (op === "toggle") todos[at]!.done = !todos[at]!.done;
      else todos.splice(at, 1);
      todos.forEach((t, i) => (t.index = i + 1));
    } else {
      throw mockError(400, "bad_request", 'op must be "add", "toggle" or "remove"');
    }
    return todos.map((t) => ({ ...t }));
  }

  if (method === "GET" && path === "/api/balance")
    return { balance: { currency: "USD", totalBalance: "23.45" } };

  if (method === "GET" && path === "/api/mcp/resources") {
    await delay(400); // spawning takes a moment
    return {
      resources: [
        { server: "context7", uri: "docs://react/hooks", name: "React hooks docs" },
        { server: "context7", uri: "docs://zustand/getting-started" },
      ],
    };
  }

  if (method === "GET" && path === "/api/mcp") return mockMcpServers.map((s) => ({ ...s }));
  m = /^\/api\/mcp\/([^/]+)\/tools$/.exec(path);
  if (method === "POST" && m) {
    const tools = mockMcpTools[decodeURIComponent(m[1]!)];
    if (!tools) throw mockError(504, "mcp_launch_failed", "failed to launch MCP server");
    await delay(400); // spawning takes a moment
    return tools;
  }

  if (method === "GET" && path === "/api/files") {
    const q = (new URLSearchParams(fullPath.split("?")[1] ?? "").get("q") ?? "").toLowerCase();
    const files = mockWorkspaceFiles.filter((f) => q === "" || f.toLowerCase().includes(q));
    return { files, truncated: false };
  }

  if (method === "POST" && path === "/api/upload") {
    const { name, dataBase64 } = (body ?? {}) as { name?: string; dataBase64?: string };
    if (!name || !dataBase64) throw mockError(400, "bad_request", "body must be {name, dataBase64}");
    const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
    if (!["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      throw mockError(400, "bad_request", `unsupported image extension ".${ext}"`);
    }
    uploadCounter += 1;
    return { path: `.seekforge/uploads/img-mock${uploadCounter}.${ext}` };
  }

  if (method === "POST" && path === "/api/rewind") {
    const { sessionId } = (body ?? {}) as { sessionId?: string; dryRun?: boolean };
    const result = sessionId ? mockRewindResults[sessionId] : undefined;
    if (!result) throw mockError(404, "no_checkpoints", "no checkpoints recorded for this session");
    // dryRun and the real run report the same paths in the mock.
    return { ...result, restored: [...result.restored], deleted: [...result.deleted], skipped: [...result.skipped] };
  }

  throw new Error(`mock: unhandled ${method} ${path}`);
}
