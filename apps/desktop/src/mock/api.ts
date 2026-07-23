/** Mock REST backend: same paths/shapes as SERVER-API.md. */
import { formatCostUsd } from "@seekforge/shared/format";
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
  McpServer,
  MemoryCandidate,
  MemoryCandidateType,
  MemoryFact,
  PluginRecord,
  ServerConfig,
  SecurityEvidencePackage,
  SessionMeta,
  Skill,
  Todo,
} from "../types";

// Mutable copies so approve/reject and config saves stick for the page lifetime.
const candidates: MemoryCandidate[] = mockCandidates.map((c) => ({ ...c }));
const facts: MemoryFact[] = mockFacts.map((f) => ({ ...f }));
const config: ServerConfig = { ...mockConfig, commandAllowlist: [...(mockConfig.commandAllowlist ?? [])] };
const proposals: EvolutionProposal[] = mockEvolutionProposals.map((p) => ({ ...p }));
// Mutable so skill toggle/create/import/delete, session delete/prune and MCP
// add/remove stick for the page lifetime (mock mode + tests).
const skills: Skill[] = mockSkills.map((s) => ({ ...s }));
const plugins: PluginRecord[] = [];
const sessions: SessionMeta[] = mockSessions.map((s) => ({ ...s }));
// Monotonic counter so each fork yields a fresh, distinct session id.
let forkSeq = 0;
const mcpServers: McpServer[] = mockMcpServers.map((s) => ({ ...s }));
const security: SecurityEvidencePackage = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: "workspace",
  findings: [],
  scans: [],
  fixes: [],
  threatModels: [],
  events: [],
  disclaimer: "This export is an evidence package, not a certification or guarantee of compliance.",
};
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

/** Mock recent projects (not currently hosted) for the "open recent" menu. */
let mockRecents = [
  { name: "old-service", path: "/mock/old-service" },
  { name: "scratch", path: "/mock/scratch" },
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

/**
 * In-memory file tree for the Files view. Files carry editable content; the
 * /api/tree listing is derived from the keys so a directory appears once any
 * file under it exists. Edits via PUT /api/file stick for the page lifetime.
 */
const mockFiles: Record<string, string> = {
  "AGENTS.md": "# Agent rules\n\n- Prefer small, reviewable diffs.\n- Keep tests green.\n",
  "README.md": "# Mock workspace\n\nThis is a fixture project used in mock mode.\n",
  "package.json": '{\n  "name": "mock-workspace",\n  "version": "0.0.0"\n}\n',
  "src/app.ts": 'export const title = "New";\n\nexport function render() {\n  return title;\n}\n',
  "src/index.css": ":root {\n  color-scheme: dark;\n}\n",
  "src/lib/api.ts": "export const api = {};\n",
};

/** A binary/oversized fixture so the Files view's "truncated" badge is testable. */
const TRUNCATED_PATH = "src/big.bin";

/** Derives one directory's listing (dirs + files) from the flat file map. */
function mockTree(dir: string): { name: string; path: string; type: "file" | "dir" }[] {
  const prefix = dir === "" ? "" : `${dir.replace(/\/+$/, "")}/`;
  const dirs = new Set<string>();
  const files: { name: string; path: string; type: "file" | "dir" }[] = [];
  for (const full of Object.keys(mockFiles)) {
    if (!full.startsWith(prefix)) continue;
    const rest = full.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      files.push({ name: rest, path: full, type: "file" });
    } else {
      dirs.add(rest.slice(0, slash));
    }
  }
  const dirEntries = [...dirs].sort().map((name) => ({ name, path: `${prefix}${name}`, type: "dir" as const }));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return [...dirEntries, ...files];
}

/** In-memory git working tree for the Source Control view. */
type MockGitFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
  staged: boolean;
};
const mockGit: { notGit: boolean; branch: string; files: MockGitFile[] } = {
  notGit: false,
  branch: "main",
  files: [
    { path: "src/app.ts", status: "modified", staged: false },
    { path: "src/feature.ts", status: "added", staged: true },
    { path: "old.txt", status: "deleted", staged: false },
    { path: "notes.md", status: "untracked", staged: false },
  ],
};
let mockCommitSeq = 0;

/** Custom slash commands for the composer palette. */
const mockCommands = [
  {
    name: "review",
    description: "Review the current diff for bugs",
    scope: "project" as const,
    body: "Please review the current diff and point out any correctness bugs.",
  },
  {
    name: "test",
    description: "Run the test suite and fix failures",
    scope: "user" as const,
    body: "Run the test suite, then fix any failing tests.",
  },
];

/** Editable user-owned hooks (mock of /api/hooks). */
let mockHooks: Record<string, unknown> = {};

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

  const hostedWorkspaces = () => [
    ...mockWorkspaces,
    ...mockWorktrees.map((w) => ({ id: w.id, name: w.branch.split("/")[1]!, path: w.path })),
  ];
  if (method === "GET" && path === "/api/workspaces") return { workspaces: hostedWorkspaces(), recents: mockRecents };
  if (method === "POST" && path === "/api/workspaces") {
    const { path: p } = (body ?? {}) as { path?: string };
    if (!p) throw mockError(400, "bad_request", "body must be {path: string}");
    const name = p.split("/").filter(Boolean).pop() ?? p;
    const id = `mock-${name}`;
    if (!mockWorkspaces.some((w) => w.id === id)) mockWorkspaces.push({ id, name, path: p });
    mockRecents = mockRecents.filter((r) => r.path !== p);
    return { workspace: { id, name, path: p }, workspaces: hostedWorkspaces(), recents: mockRecents };
  }
  if (method === "DELETE" && path === "/api/workspaces/recent") {
    const p = fullPath.split("?")[1]?.match(/path=([^&]+)/)?.[1];
    if (p) mockRecents = mockRecents.filter((r) => r.path !== decodeURIComponent(p));
    return { workspaces: hostedWorkspaces(), recents: mockRecents };
  }
  {
    const wm = /^\/api\/workspaces\/([^/]+)$/.exec(path);
    if (method === "DELETE" && wm) {
      const idx = mockWorkspaces.findIndex((w) => w.id === wm[1]);
      if (idx > 0) mockWorkspaces.splice(idx, 1); // index 0 is the default
      return { workspaces: hostedWorkspaces(), recents: mockRecents };
    }
  }

  if (method === "GET" && path === "/api/worktrees") return mockWorktrees.map((w) => ({ ...w }));
  if (method === "POST" && path === "/api/worktrees") {
    const { name } = (body ?? {}) as { name?: string };
    const slug =
      (name ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `session-${++mockWorktreeSeq}`;
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
    return { ok: true, scope: "project" };
  }
  if (method === "GET" && path === "/api/health")
    return { version: "0.2.0-mock", workspace: "/mock/workspace", workspaces: mockWorkspaces };
  if (method === "GET" && path === "/api/sessions") return sessions.map((s) => ({ ...s }));

  // Prune old sessions (olderThanDays / keepLast, with dry-run preview).
  if (method === "POST" && path === "/api/sessions/prune") {
    const { olderThanDays, keepLast, dryRun } = (body ?? {}) as {
      olderThanDays?: number;
      keepLast?: number;
      dryRun?: boolean;
    };
    // Newest first; everything beyond keepLast or older than the cutoff is pruned.
    const ordered = [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    const cutoff = typeof olderThanDays === "number" ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;
    const removed: string[] = [];
    ordered.forEach((s, i) => {
      const tooOld = cutoff !== null && Date.parse(s.updatedAt) < cutoff;
      const beyondKeep = typeof keepLast === "number" && i >= keepLast;
      if (tooOld || beyondKeep) removed.push(s.id);
    });
    if (!dryRun) {
      for (const id of removed) {
        const idx = sessions.findIndex((s) => s.id === id);
        if (idx >= 0) sessions.splice(idx, 1);
      }
    }
    // kept = the count that survives the prune (same whether dry-run or applied).
    return { removed, kept: ordered.length - removed.length };
  }

  let m = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (method === "DELETE" && m) {
    const idx = sessions.findIndex((s) => s.id === m![1]);
    if (idx < 0) throw mockError(404, "not_found", "session not found");
    sessions.splice(idx, 1);
    return { deleted: true };
  }
  if (method === "GET" && m) {
    const meta = sessions.find((s) => s.id === m![1]);
    if (!meta) throw new Error("session not found");
    return { meta, messages: mockSessionMessages[meta.id] ?? [], events: [] };
  }

  if (method === "GET" && path === "/api/skills") return skills.map((s) => ({ ...s }));
  if (method === "GET" && path === "/api/skills/diagnostics") return { diagnostics: [] };

  if (method === "GET" && path === "/api/plugins") return plugins.map((plugin) => ({ ...plugin }));
  if (method === "POST" && path === "/api/plugins") {
    const { id } = (body ?? {}) as { id?: string };
    if (!id) throw mockError(400, "bad_request", "body must be {id: string}");
    if (plugins.some((plugin) => plugin.id === id && plugin.scope === "project")) {
      throw mockError(409, "already_exists", `plugin ${id} already exists`);
    }
    const plugin: PluginRecord = {
      id,
      scope: "project",
      path: `/mock/workspace/.seekforge/plugins/${id}`,
      status: "review_required",
      digest: `mock-${id}`,
      manifest: { apiVersion: 1, id, name: id, version: "0.1.0", description: "SeekForge plugin" },
    };
    plugins.push(plugin);
    return plugin;
  }
  if (method === "POST" && path === "/api/plugins/install") {
    const { path: source } = (body ?? {}) as { path?: string };
    if (!source) throw mockError(400, "bad_request", "body must be {path: string}");
    const project = plugins.find((plugin) => plugin.path === source);
    const id = project?.id ?? source.split("/").filter(Boolean).pop() ?? "plugin";
    const existing = plugins.findIndex((plugin) => plugin.id === id && plugin.scope === "global");
    const plugin: PluginRecord = {
      id,
      scope: "global",
      path: `/mock/home/.seekforge/plugins/${id}`,
      status: "disabled",
      digest: project?.digest ?? `mock-${id}`,
      manifest: project?.manifest ?? { apiVersion: 1, id, name: id, version: "0.1.0" },
    };
    if (existing >= 0) plugins[existing] = plugin;
    else plugins.push(plugin);
    return { manifest: plugin.manifest, path: plugin.path, digest: plugin.digest, updated: existing >= 0 };
  }
  {
    const pluginMatch = /^\/api\/plugins\/([^/]+)$/.exec(path);
    if (method === "PUT" && pluginMatch) {
      const plugin = plugins.find((item) => item.id === decodeURIComponent(pluginMatch[1]!) && item.scope === "global");
      if (!plugin) throw mockError(404, "not_found", `unknown plugin: ${pluginMatch[1]}`);
      const { enabled } = (body ?? {}) as { enabled?: boolean };
      if (typeof enabled !== "boolean") throw mockError(400, "bad_request", "body must be {enabled: boolean}");
      plugin.status = enabled ? "enabled" : "disabled";
      return { id: plugin.id, enabled, digest: plugin.digest ?? "" };
    }
    if (method === "DELETE" && pluginMatch) {
      const index = plugins.findIndex(
        (item) => item.id === decodeURIComponent(pluginMatch[1]!) && item.scope === "global",
      );
      if (index < 0) throw mockError(404, "not_found", `unknown plugin: ${pluginMatch[1]}`);
      const [removed] = plugins.splice(index, 1);
      return { id: removed!.id, removed: removed!.path };
    }
  }
  // Create a new (empty) project skill from an id.
  if (method === "POST" && path === "/api/skills") {
    const { id } = (body ?? {}) as { id?: string };
    if (typeof id !== "string" || id.trim() === "") throw mockError(400, "bad_request", "body must be {id: string}");
    const trimmed = id.trim();
    if (skills.some((s) => s.id === trimmed)) throw mockError(409, "exists", `skill "${trimmed}" already exists`);
    const skill: Skill = {
      id: trimmed,
      scope: "project",
      name: trimmed,
      description: "New skill — edit its SKILL.md to describe it.",
      tags: [],
      triggers: [],
      priority: 0,
      enabled: true,
      risk: "low",
    };
    skills.push(skill);
    return { ...skill };
  }
  // Import a skill from a path (project, or global).
  if (method === "POST" && path === "/api/skills/import") {
    const { path: p, global } = (body ?? {}) as { path?: string; global?: boolean };
    if (typeof p !== "string" || p.trim() === "") throw mockError(400, "bad_request", "body must include a path");
    const id = (p.split("/").filter(Boolean).pop() ?? "imported-skill").replace(/[^a-z0-9-]+/gi, "-");
    const skill: Skill = {
      id,
      scope: global ? "global" : "project",
      name: id,
      description: `Imported from ${p}`,
      tags: [],
      triggers: [],
      priority: 0,
      enabled: true,
      risk: "low",
    };
    const existing = skills.findIndex((s) => s.id === id);
    if (existing >= 0) skills[existing] = skill;
    else skills.push(skill);
    return { ...skill };
  }
  m = /^\/api\/skills\/([^/]+)$/.exec(path);
  if (method === "PUT" && m) {
    const skill = skills.find((s) => s.id === m![1]);
    if (!skill) throw mockError(404, "not_found", "skill not found");
    if (skill.scope === "builtin") throw mockError(400, "read_only", "builtin skills are read-only");
    const { enabled, scope } = (body ?? {}) as { enabled?: boolean; scope?: Skill["scope"] };
    if (typeof enabled === "boolean") skill.enabled = enabled;
    if (scope === "global" || scope === "project") skill.scope = scope;
    return { ...skill };
  }
  if (method === "DELETE" && m) {
    const idx = skills.findIndex((s) => s.id === m![1]);
    if (idx < 0) throw mockError(404, "not_found", "skill not found");
    if (skills[idx]!.scope === "builtin") throw mockError(400, "read_only", "builtin skills are read-only");
    skills.splice(idx, 1);
    return { deleted: true };
  }
  if (method === "GET" && m) {
    const skill = skills.find((s) => s.id === m![1]);
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
    return { projectMd: mockProjectMd, candidates, facts: facts.map((f) => ({ ...f })), maintenance: null };
  }
  if (method === "GET" && path === "/api/memory/stats") {
    const pending = candidates.filter((c) => c.status === "pending").length;
    const approved = candidates.filter((c) => c.status === "approved").length;
    const rejected = candidates.filter((c) => c.status === "rejected").length;
    const total = pending + approved + rejected;
    const used = facts.filter((f) => f.uses > 0).length;
    return {
      totalApprovedFacts: facts.length,
      autoExtractedFacts: facts.filter((f) => f.addedAt !== undefined).length,
      directAddedFacts: facts.filter((f) => f.addedAt === undefined).length,
      usedFraction: facts.length > 0 ? used / facts.length : 0,
      rejectionRate: total > 0 ? rejected / total : 0,
      avgConfidenceUsed: 0.82,
      avgConfidenceUnused: 0.61,
      pending,
      approved,
      rejected,
    };
  }
  if (method === "POST" && path === "/api/memory/compact") {
    const { dryRun, pruneUnusedDays } = (body ?? {}) as { dryRun?: boolean; pruneUnusedDays?: number };
    const before = facts.length;
    // Pretend the last two facts are exact/near duplicates, and (when pruning)
    // never-used facts older than the cutoff are archived.
    const removed = before >= 2 ? [`- [convention] ${facts[before - 1]!.content}`] : [];
    const merged =
      before >= 3 ? [{ kept: `- [tech] ${facts[0]!.content}`, dropped: `- [tech] ${facts[1]!.content}` }] : [];
    const archived =
      typeof pruneUnusedDays === "number"
        ? facts
            .filter((f) => f.uses === 0)
            .slice(0, 1)
            .map((f) => `- [${f.type ?? "convention"}] ${f.content}`)
        : [];
    const after = before - removed.length - merged.length - archived.length;
    if (!dryRun) {
      // Reflect the compaction in the mock fact list so a refresh shows fewer.
      const drop = removed.length + merged.length + archived.length;
      facts.splice(facts.length - drop);
      facts.forEach((f, i) => {
        f.index = i + 1;
      });
    }
    return { before, after, removed, merged, archived };
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
    facts.forEach((f, i) => {
      f.index = i + 1;
    });
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
      case "planModel":
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
      case "escalateOnFailure":
        config.escalateOnFailure = String(value) === "true";
        break;
      case "memoryAutoApproveConfidence": {
        const v = String(value).trim();
        if (v === "") config.memoryAutoApproveConfidence = undefined;
        else config.memoryAutoApproveConfidence = Number(v);
        break;
      }
      case "memoryMaintenance":
        config.memoryMaintenance = { ...(value as NonNullable<ServerConfig["memoryMaintenance"]>) };
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
  if (method === "POST" && path === "/api/agents/import") {
    const { path: p, global } = (body ?? {}) as { path?: string; global?: boolean };
    if (typeof p !== "string" || p.trim() === "") throw mockError(400, "bad_request", "body must include a path");
    const id = (p.split("/").filter(Boolean).pop() ?? "imported-agent").replace(/[^a-z0-9-]+/gi, "-");
    return {
      ok: true,
      dir: `${global ? "~/.seekforge" : ".seekforge"}/agents/${id}`,
      agent: { id, name: id, description: `Imported from ${p}`, triggers: [], mode: "edit" },
      droppedTools: ["UnsupportedTool"],
    };
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
      todos.forEach((t, i) => {
        t.index = i + 1;
      });
    } else {
      throw mockError(400, "bad_request", 'op must be "add", "toggle" or "remove"');
    }
    return todos.map((t) => ({ ...t }));
  }

  if (method === "GET" && path === "/api/balance") return { balance: { currency: "USD", totalBalance: "23.45" } };
  if (method === "POST" && path === "/api/provider/verify") return { ok: true };

  if (method === "GET" && path === "/api/mcp/resources") {
    await delay(400); // spawning takes a moment
    return {
      resources: [
        { server: "context7", uri: "docs://react/hooks", name: "React hooks docs" },
        { server: "context7", uri: "docs://zustand/getting-started" },
      ],
    };
  }

  if (method === "GET" && path === "/api/mcp/prompts") {
    await delay(300);
    return {
      prompts: [
        { server: "context7", name: "review", description: "Review a feature against current documentation." },
        {
          server: "context7",
          name: "explain-library",
          description: "Explain a library API for a target audience.",
          arguments: [{ name: "library", required: true }, { name: "audience" }],
        },
      ],
    };
  }
  if (method === "POST" && path.startsWith("/api/mcp/prompts/")) {
    const parts = path.split("/").map(decodeURIComponent);
    const server = parts[4] ?? "server";
    const name = parts[5] ?? "prompt";
    const args = (body as { arguments?: Record<string, unknown> } | undefined)?.arguments ?? {};
    return { text: `Use MCP prompt ${server}/${name}.\n\nArguments: ${JSON.stringify(args)}` };
  }

  if (method === "GET" && path === "/api/mcp") return mcpServers.map((s) => ({ ...s }));
  if (method === "POST" && path === "/api/mcp") {
    const { name, scope, command, args, env, url, headers, oauth, trusted } = (body ?? {}) as {
      name?: string;
      scope?: "global" | "project";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      headers?: Record<string, string>;
      oauth?: McpServer["oauth"];
      trusted?: boolean;
    };
    if (typeof name !== "string" || name.trim() === "") throw mockError(400, "bad_request", "body must include a name");
    if (!command && !url) throw mockError(400, "bad_request", "provide a command (stdio) or url (http)");
    const srv: McpServer = {
      name,
      transport: url ? "http" : "stdio",
      ...(command ? { command } : {}),
      args: args ?? [],
      ...(url ? { url } : {}),
      trusted: trusted ?? false,
      env: Object.fromEntries(Object.keys(env ?? {}).map((key) => [key, "********"])),
      headers: Object.fromEntries(Object.keys(headers ?? {}).map((key) => [key, "********"])),
      ...(oauth
        ? { oauth: { ...oauth, refreshToken: "********", ...(oauth.clientSecret ? { clientSecret: "********" } : {}) } }
        : {}),
      source: scope ?? "project",
      shadowedGlobal: false,
    };
    const existing = mcpServers.findIndex((server) => server.name === name);
    if (existing >= 0) mcpServers[existing] = srv;
    else mcpServers.push(srv);
    return { ok: true, server: { ...srv } };
  }
  m = /^\/api\/mcp\/([^/]+)\/tools$/.exec(path);
  if (method === "POST" && m) {
    const tools = mockMcpTools[decodeURIComponent(m[1]!)];
    if (!tools) throw mockError(504, "mcp_launch_failed", "failed to launch MCP server");
    await delay(400); // spawning takes a moment
    return { tools };
  }
  m = /^\/api\/mcp\/([^/]+)\/test$/.exec(path);
  if (method === "POST" && m) {
    const tools = mockMcpTools[decodeURIComponent(m[1]!)];
    if (!tools) throw mockError(502, "mcp_error", "connection failed");
    return { ok: true, latencyMs: 18, toolCount: tools.length };
  }
  m = /^\/api\/mcp\/([^/]+)$/.exec(path);
  if (method === "DELETE" && m) {
    const idx = mcpServers.findIndex((s) => s.name === decodeURIComponent(m![1]!));
    if (idx < 0) throw mockError(404, "not_found", "server not found");
    const scope = new URLSearchParams(fullPath.split("?")[1] ?? "").get("scope") ?? "project";
    mcpServers.splice(idx, 1);
    return { ok: true, scope };
  }

  if (method === "GET" && path === "/api/security") return structuredClone(security);
  if (method === "POST" && path === "/api/security/scan") {
    const scan = {
      id: `scan-${security.scans.length + 1}`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: "completed" as const,
      scanner: "mock",
      scannerVersion: "1",
      findingIds: [],
    };
    security.scans.push(scan);
    return { scan, findings: [] };
  }
  if (method === "POST" && path === "/api/security/threat-model")
    throw mockError(502, "threat_model_failed", "mock threat model needs a configured provider");
  if (method === "GET" && path === "/api/security/export") {
    const format = new URLSearchParams(fullPath.split("?")[1] ?? "").get("format") ?? "json";
    return {
      format,
      filename: `seekforge-security-report.${format === "markdown" ? "md" : "json"}`,
      content: JSON.stringify(security, null, 2),
      disclaimer: security.disclaimer,
    };
  }

  if (method === "GET" && path === "/api/files") {
    const q = (new URLSearchParams(fullPath.split("?")[1] ?? "").get("q") ?? "").toLowerCase();
    const files = mockWorkspaceFiles.filter((f) => q === "" || f.toLowerCase().includes(q));
    return { files, truncated: false };
  }

  // Project-wide content search over the mock file map.
  if (method === "GET" && path === "/api/search") {
    const params = new URLSearchParams(fullPath.split("?")[1] ?? "");
    const q = params.get("q") ?? "";
    if (q === "") return { hits: [], truncated: false };
    let re: RegExp;
    try {
      re = new RegExp(
        params.get("regex") === "1" ? q : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        params.get("case") === "1" ? "" : "i",
      );
    } catch {
      return { hits: [], truncated: false, error: "invalid regex" };
    }
    const hits: { path: string; line: number; text: string; col: number; len: number }[] = [];
    for (const [p, content] of Object.entries(mockFiles)) {
      content.split("\n").forEach((line, i) => {
        const m = re.exec(line);
        if (m && m[0].length > 0)
          hits.push({ path: p, line: i + 1, text: line.slice(0, 240), col: m.index, len: m[0].length });
      });
    }
    return { hits, truncated: false };
  }

  if (method === "GET" && path === "/api/output-styles") {
    return {
      styles: [
        { name: "default", kind: "builtin" },
        { name: "concise", kind: "builtin" },
        { name: "explanatory", kind: "builtin" },
        { name: "learning", kind: "builtin" },
      ],
    };
  }

  if (path === "/api/hooks") {
    if (method === "GET") return { hooks: mockHooks };
    if (method === "PUT") {
      mockHooks = ((body ?? {}) as { hooks?: Record<string, unknown> }).hooks ?? {};
      return { hooks: mockHooks };
    }
  }

  if (method === "POST" && path === "/api/commands/expand") {
    const { name, args } = (body ?? {}) as { name?: string; args?: string };
    const cmd = mockCommands.find((c) => c.name === name);
    if (!cmd) throw mockError(404, "not_found", `unknown command: ${name}`);
    return { text: cmd.body.split("$ARGUMENTS").join(args ?? "") };
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

  if (method === "GET" && path === "/api/doctor") {
    return {
      apiKeyConfigured: !!config.apiKey,
      nodeVersion: "v22.11.0",
      git: "git version 2.43.0",
      runtimeBin: { set: !!config.runtimeBin, exists: false },
      mcpServerCount: mcpServers.length,
      modelCount: mockModels.length,
      workspace: "/mock/workspace",
    };
  }

  // --- Files browser + editor ----------------------------------------------
  if (method === "GET" && path === "/api/tree") {
    const dir = new URLSearchParams(fullPath.split("?")[1] ?? "").get("path") ?? "";
    return { path: dir, entries: mockTree(dir) };
  }
  if (method === "GET" && path === "/api/file") {
    const rel = new URLSearchParams(fullPath.split("?")[1] ?? "").get("path") ?? "";
    if (rel === TRUNCATED_PATH) return { path: rel, content: "<binary preview>\n", truncated: true };
    if (!(rel in mockFiles)) throw mockError(404, "not_found", `file not found: ${rel}`);
    return { path: rel, content: mockFiles[rel]!, truncated: false };
  }
  if (method === "PUT" && path === "/api/file") {
    const { path: rel, content } = (body ?? {}) as { path?: unknown; content?: unknown };
    if (typeof rel !== "string" || rel.trim() === "") throw mockError(400, "bad_request", "body must include a path");
    if (typeof content !== "string") throw mockError(400, "bad_request", "content must be a string");
    mockFiles[rel] = content;
    return { ok: true };
  }

  // --- Source control ------------------------------------------------------
  if (method === "GET" && path === "/api/git/status") {
    if (mockGit.notGit) return { notGit: true, branch: "", files: [] };
    return { branch: mockGit.branch, files: mockGit.files.map((f) => ({ ...f })) };
  }
  if (method === "POST" && (path === "/api/git/stage" || path === "/api/git/unstage")) {
    const { paths } = (body ?? {}) as { paths?: unknown };
    if (!Array.isArray(paths)) throw mockError(400, "bad_request", "body must be {paths: string[]}");
    const staged = path === "/api/git/stage";
    for (const f of mockGit.files) if (paths.includes(f.path)) f.staged = staged;
    return { ok: true };
  }
  if (method === "POST" && path === "/api/git/discard") {
    const { paths } = (body ?? {}) as { paths?: unknown };
    if (!Array.isArray(paths)) throw mockError(400, "bad_request", "body must be {paths: string[]}");
    mockGit.files = mockGit.files.filter((f) => !paths.includes(f.path));
    return { ok: true };
  }
  if (method === "POST" && path === "/api/git/commit") {
    const { message } = (body ?? {}) as { message?: unknown };
    if (typeof message !== "string" || message.trim() === "") {
      throw mockError(400, "bad_request", "commit message must be a non-empty string");
    }
    if (!mockGit.files.some((f) => f.staged)) throw mockError(400, "nothing_staged", "nothing staged to commit");
    mockGit.files = mockGit.files.filter((f) => !f.staged);
    return { ok: true, commit: `mockcommit${++mockCommitSeq}` };
  }

  // --- Custom slash commands -----------------------------------------------
  if (method === "GET" && path === "/api/commands") {
    return { commands: mockCommands.map((c) => ({ ...c })) };
  }

  // --- Manual session compaction -------------------------------------------
  m = /^\/api\/sessions\/([^/]+)\/compact$/.exec(path);
  if (method === "POST" && m) {
    const meta = sessions.find((s) => s.id === m![1]);
    if (!meta) throw mockError(404, "not_found", "session not found");
    return { ok: true, sessionId: meta.id, before: 42, after: 12, summary: "Mock compaction summary." };
  }

  // --- Fork a session into a new copy --------------------------------------
  m = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
  if (method === "POST" && m) {
    const src = sessions.find((s) => s.id === m![1]);
    if (!src) throw mockError(404, "not_found", "session not found");
    const now = new Date().toISOString();
    const forked: SessionMeta = {
      ...src,
      id: `mock-fork-${++forkSeq}`,
      task: `(fork) ${src.task}`,
      status: "completed",
      createdAt: now,
      updatedAt: now,
    };
    sessions.unshift(forked);
    // The forked copy carries the source transcript so opening it lands in the
    // continued session (GET /api/sessions/:id reads from this map).
    mockSessionMessages[forked.id] = [...(mockSessionMessages[src.id] ?? [])];
    return { id: forked.id };
  }

  // --- Reviewable session audit --------------------------------------------
  m = /^\/api\/sessions\/([^/]+)\/audit$/.exec(path);
  if (method === "GET" && m) {
    const meta = sessions.find((s) => s.id === m![1]);
    if (!meta) throw mockError(404, "not_found", "session not found");
    const markdown = [
      `# Audit — ${meta.task}`,
      "",
      `Session \`${meta.id}\` · status **${meta.status}**`,
      "",
      "## Turn 1",
      "",
      "- Tool `read_file` — `src/app.ts`",
      "- Tool `edit_file` — `src/app.ts`",
      "",
      "**Files changed:** `src/app.ts`",
      "",
      "## Totals",
      "",
      "- Tokens: 4,210 in · 1,180 out",
      `- Cost: ${meta.usage ? formatCostUsd(meta.usage.costUsd) : "$0.0000"}`,
    ].join("\n");
    return {
      markdown,
      audit: {
        sessionId: meta.id,
        turns: [
          {
            turn: 1,
            toolCalls: ["read_file", "edit_file"],
            filesChanged: ["src/app.ts"],
          },
        ],
        totals: {
          tokensIn: 4210,
          tokensOut: 1180,
          costUsd: meta.usage?.costUsd ?? 0,
        },
      },
    };
  }

  throw new Error(`mock: unhandled ${method} ${path}`);
}
