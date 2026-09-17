import { describe, expect, it } from "vitest";
import { mockRequest } from "./api";
import type {
  CommandsResponse,
  CompactResult,
  DoctorReport,
  FileContent,
  GitStatus,
  McpServer,
  MemoryStats,
  PluginInstallResult,
  ProjectMcpServer,
  PruneResult,
  RewindResult,
  ServerConfig,
  SessionCompactResult,
  SessionMeta,
  Skill,
  TreeResponse,
} from "../types";

describe("mockRequest — memory stats + compact", () => {
  it("returns plausible MemoryStats with fractions in 0..1", async () => {
    const stats = (await mockRequest("GET", "/api/memory/stats")) as MemoryStats;
    expect(stats.totalApprovedFacts).toBeGreaterThanOrEqual(0);
    expect(stats.usedFraction).toBeGreaterThanOrEqual(0);
    expect(stats.usedFraction).toBeLessThanOrEqual(1);
    expect(stats.rejectionRate).toBeGreaterThanOrEqual(0);
    expect(stats.rejectionRate).toBeLessThanOrEqual(1);
    expect(stats.pending + stats.approved + stats.rejected).toBeGreaterThanOrEqual(0);
  });

  it("dry-run compact reports a plan without mutating the fact count", async () => {
    const before = (await mockRequest("GET", "/api/memory/stats")) as MemoryStats;
    const plan = (await mockRequest("POST", "/api/memory/compact", { dryRun: true })) as CompactResult;
    expect(plan.before).toBeGreaterThanOrEqual(plan.after);
    const after = (await mockRequest("GET", "/api/memory/stats")) as MemoryStats;
    expect(after.totalApprovedFacts).toBe(before.totalApprovedFacts);
  });
});

describe("mockRequest — skills lifecycle", () => {
  it("toggles a non-builtin skill's enabled flag", async () => {
    const skills = (await mockRequest("GET", "/api/skills")) as Skill[];
    const target = skills.find((s) => s.scope !== "builtin")!;
    const updated = (await mockRequest("PUT", `/api/skills/${target.id}`, {
      enabled: !target.enabled,
    })) as Skill;
    expect(updated.enabled).toBe(!target.enabled);
  });

  it("rejects toggling a builtin skill (read-only)", async () => {
    const skills = (await mockRequest("GET", "/api/skills")) as Skill[];
    const builtin = skills.find((s) => s.scope === "builtin")!;
    await expect(mockRequest("PUT", `/api/skills/${builtin.id}`, { enabled: false })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("creates a new project skill and then deletes it", async () => {
    const created = (await mockRequest("POST", "/api/skills", { id: "test-skill" })) as Skill;
    expect(created.id).toBe("test-skill");
    expect(created.scope).toBe("project");
    const deleted = (await mockRequest("DELETE", "/api/skills/test-skill")) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
  });

  it("imports a skill from a path", async () => {
    const imported = (await mockRequest("POST", "/api/skills/import", {
      path: "/tmp/my-imported-skill",
      global: true,
    })) as Skill;
    expect(imported.scope).toBe("global");
  });
});

describe("mockRequest — sessions lifecycle", () => {
  it("prune dry-run keeps + removes sum to the total and does not mutate", async () => {
    const before = (await mockRequest("GET", "/api/sessions")) as SessionMeta[];
    const plan = (await mockRequest("POST", "/api/sessions/prune", { keepLast: 0, dryRun: true })) as PruneResult;
    expect(plan.removed.length + plan.kept).toBe(before.length);
    const after = (await mockRequest("GET", "/api/sessions")) as SessionMeta[];
    expect(after.length).toBe(before.length);
  });

  it("deletes a session by id", async () => {
    const sessions = (await mockRequest("GET", "/api/sessions")) as SessionMeta[];
    const id = sessions[0]!.id;
    const res = (await mockRequest("DELETE", `/api/sessions/${id}`)) as { deleted: boolean };
    expect(res.deleted).toBe(true);
    const remaining = (await mockRequest("GET", "/api/sessions")) as SessionMeta[];
    expect(remaining.some((s) => s.id === id)).toBe(false);
  });
});

describe("mockRequest — mcp add/remove + agents import + doctor", () => {
  it("adds a stdio MCP server then removes it", async () => {
    const added = (await mockRequest("POST", "/api/mcp", {
      name: "test-mcp",
      command: "npx",
      args: ["-y", "pkg"],
    })) as { ok: true; server: McpServer };
    expect(added.server.name).toBe("test-mcp");
    const removed = (await mockRequest("DELETE", "/api/mcp/test-mcp?scope=project")) as { ok: true; scope: string };
    expect(removed.ok).toBe(true);
  });

  it("rejects adding an MCP server with neither command nor url", async () => {
    await expect(mockRequest("POST", "/api/mcp", { name: "bad" })).rejects.toMatchObject({ status: 400 });
  });

  it("imports an agent from a path", async () => {
    const result = (await mockRequest("POST", "/api/agents/import", { path: "/tmp/reviewer" })) as {
      agent: { id: string };
      droppedTools: string[];
    };
    expect(result.agent.id).toBe("reviewer");
    expect(result.droppedTools).toEqual(["UnsupportedTool"]);
  });

  it("returns a DoctorReport", async () => {
    const report = (await mockRequest("GET", "/api/doctor")) as DoctorReport;
    expect(typeof report.apiKeyConfigured).toBe("boolean");
    expect(report.nodeVersion).toMatch(/^v/);
    expect(report.modelCount).toBeGreaterThan(0);
  });
});

describe("mockRequest — files tree + read/write", () => {
  it("lists the root tree with dirs before files", async () => {
    const tree = (await mockRequest("GET", "/api/tree")) as TreeResponse;
    expect(tree.path).toBe("");
    expect(tree.entries.length).toBeGreaterThan(0);
    expect(tree.entries.some((e) => e.type === "dir")).toBe(true);
    expect(tree.entries.some((e) => e.name === "AGENTS.md")).toBe(true);
  });

  it("lazily lists a subdirectory by path", async () => {
    const tree = (await mockRequest("GET", "/api/tree?path=src")) as TreeResponse;
    expect(tree.path).toBe("src");
    expect(tree.entries.some((e) => e.path === "src/app.ts")).toBe(true);
  });

  it("reads a file's content", async () => {
    const file = (await mockRequest("GET", "/api/file?path=AGENTS.md")) as FileContent;
    expect(file.path).toBe("AGENTS.md");
    expect(file.truncated).toBe(false);
    expect(file.content.length).toBeGreaterThan(0);
  });

  it("flags an oversized file as truncated", async () => {
    const file = (await mockRequest("GET", "/api/file?path=src/big.bin")) as FileContent;
    expect(file.truncated).toBe(true);
  });

  it("404s an unknown file", async () => {
    await expect(mockRequest("GET", "/api/file?path=nope.txt")).rejects.toMatchObject({ status: 404 });
  });

  it("writes a file and reads the new content back", async () => {
    const res = (await mockRequest("PUT", "/api/file", { path: "AGENTS.md", content: "# Updated\n" })) as {
      ok: boolean;
    };
    expect(res.ok).toBe(true);
    const file = (await mockRequest("GET", "/api/file?path=AGENTS.md")) as FileContent;
    expect(file.content).toBe("# Updated\n");
  });
});

describe("mockRequest — source control", () => {
  it("returns a status with staged + unstaged files", async () => {
    const status = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    expect(status.notGit).toBeFalsy();
    expect(status.branch).toBe("main");
    expect(status.files.some((f) => f.staged)).toBe(true);
    expect(status.files.some((f) => !f.staged)).toBe(true);
  });

  it("stages and unstages a file", async () => {
    const before = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    const target = before.files.find((f) => !f.staged)!;
    await mockRequest("POST", "/api/git/stage", { paths: [target.path] });
    let status = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    expect(status.files.find((f) => f.path === target.path)!.staged).toBe(true);
    await mockRequest("POST", "/api/git/unstage", { paths: [target.path] });
    status = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    expect(status.files.find((f) => f.path === target.path)!.staged).toBe(false);
  });

  it("commits staged files and clears them", async () => {
    const status = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    const target = status.files.find((f) => !f.staged)!;
    await mockRequest("POST", "/api/git/stage", { paths: [target.path] });
    const res = (await mockRequest("POST", "/api/git/commit", { message: "test commit" })) as {
      ok: boolean;
      commit: string;
    };
    expect(res.ok).toBe(true);
    expect(res.commit).toMatch(/^mockcommit/);
    const after = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    expect(after.files.some((f) => f.staged)).toBe(false);
  });

  it("rejects committing an empty message", async () => {
    await expect(mockRequest("POST", "/api/git/commit", { message: "  " })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("discards a file (removes it from the working tree)", async () => {
    const status = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    const target = status.files[0]!;
    await mockRequest("POST", "/api/git/discard", { paths: [target.path] });
    const after = (await mockRequest("GET", "/api/git/status")) as GitStatus;
    expect(after.files.some((f) => f.path === target.path)).toBe(false);
  });
});

describe("mockRequest — commands + session compact", () => {
  it("returns custom slash commands with bodies", async () => {
    const res = (await mockRequest("GET", "/api/commands")) as CommandsResponse;
    expect(res.commands.length).toBeGreaterThan(0);
    for (const c of res.commands) {
      expect(typeof c.name).toBe("string");
      expect(typeof c.body).toBe("string");
      expect(["project", "user"]).toContain(c.scope);
    }
  });

  it("compacts an existing session", async () => {
    const sessions = (await mockRequest("GET", "/api/sessions")) as SessionMeta[];
    const id = sessions[0]!.id;
    const res = (await mockRequest("POST", `/api/sessions/${id}/compact`)) as SessionCompactResult;
    expect(res.droppedTurns).toBeGreaterThan(0);
    expect(res.afterTokens).toBeLessThan(res.beforeTokens ?? 0);
    expect(res.notices?.length).toBeGreaterThan(0);
  });

  it("404s compacting an unknown session", async () => {
    await expect(mockRequest("POST", "/api/sessions/does-not-exist/compact")).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("mockRequest — Graph template registry lifecycle", () => {
  it("registers, lists, compares, and deprecates an exact version", async () => {
    const baseline = {
      schemaVersion: 2,
      kind: "engineering-graph-template",
      templateId: "desktop-lifecycle",
      version: "1.0.0",
      parameters: {},
      definition: { graphId: "desktop-lifecycle", nodes: [{ id: "start", kind: "function", handler: "noop" }] },
    };
    await mockRequest("POST", "/api/graphs/templates", baseline);
    const listed = (await mockRequest("GET", "/api/graphs/templates")) as Array<{
      template: { templateId: string; version: string };
      deprecatedAt?: string;
    }>;
    expect(listed.some((entry) => entry.template.templateId === "desktop-lifecycle")).toBe(true);

    const comparison = (await mockRequest("POST", "/api/graphs/templates/desktop-lifecycle/1.0.0/compare", {
      ...baseline,
      version: "1.1.0",
      definition: { ...baseline.definition, maxConcurrency: 2 },
    })) as { fromVersion: string; toVersion: string; classification: string };
    expect(comparison).toMatchObject({ fromVersion: "1.0.0", toVersion: "1.1.0", classification: "compatible" });

    await mockRequest("POST", "/api/graphs/templates/desktop-lifecycle/1.0.0/deprecate", {});
    const deprecated = (await mockRequest("GET", "/api/graphs/templates")) as Array<{
      template: { templateId: string; version: string };
      deprecatedAt?: string;
    }>;
    expect(
      deprecated.find(
        (entry) => entry.template.templateId === "desktop-lifecycle" && entry.template.version === "1.0.0",
      )?.deprecatedAt,
    ).toBeTruthy();
  });
});

describe("mockRequest — config new keys", () => {
  it("accepts planModel / escalation / memory settings", async () => {
    await mockRequest("PUT", "/api/config", { key: "planModel", value: "deepseek-v4-pro" });
    await mockRequest("PUT", "/api/config", { key: "escalateOnFailure", value: "true" });
    const cfg = (await mockRequest("PUT", "/api/config", {
      key: "memoryAutoApproveConfidence",
      value: "0.9",
    })) as { planModel?: string; escalateOnFailure?: boolean; memoryAutoApproveConfidence?: number };
    expect(cfg.planModel).toBe("deepseek-v4-pro");
    expect(cfg.escalateOnFailure).toBe(true);
    expect(cfg.memoryAutoApproveConfidence).toBe(0.9);
    const maintained = (await mockRequest("PUT", "/api/config", {
      key: "memoryMaintenance",
      value: { enabled: true, minFacts: 20, minBytes: 4096, minIntervalHours: 6 },
    })) as ServerConfig;
    expect(maintained.memoryMaintenance).toEqual({
      enabled: true,
      minFacts: 20,
      minBytes: 4096,
      minIntervalHours: 6,
    });
  });
});

describe("mockRequest — integration contracts", () => {
  it("lists repository MCP servers and decides on the reviewed digest only", async () => {
    const { servers } = (await mockRequest("GET", "/api/mcp/project-servers")) as { servers: ProjectMcpServer[] };
    const pending = servers.find((server) => server.status === "pending")!;
    expect(pending.definition).toContain("command");
    await expect(
      mockRequest("POST", `/api/mcp/project-servers/${pending.name}/approve`, { digest: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });
    const approved = (await mockRequest("POST", `/api/mcp/project-servers/${pending.name}/approve`, {
      digest: pending.digest,
    })) as { server: ProjectMcpServer };
    expect(approved.server.status).toBe("approved");
    const rejected = (await mockRequest("POST", `/api/mcp/project-servers/${pending.name}/reject`, {
      digest: pending.digest,
    })) as { server: ProjectMcpServer };
    expect(rejected.server.status).toBe("rejected");
    await expect(
      mockRequest("POST", "/api/mcp/project-servers/not-a-repo-server/approve", { digest: pending.digest }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("installs a plugin from a source (or the legacy path field) disabled, with its provenance", async () => {
    const remote = (await mockRequest("POST", "/api/plugins/install", {
      source: "https://github.com/acme/lint-kit.git#v1",
      force: false,
    })) as PluginInstallResult;
    expect(remote.manifest?.id).toBe("lint-kit");
    expect(remote.originLabel).toContain("git https://github.com/acme/lint-kit.git#v1");
    const local = (await mockRequest("POST", "/api/plugins/install", { path: "/tmp/plugins/local-kit" })) as {
      originLabel: string;
    };
    expect(local.originLabel).toBe("local /tmp/plugins/local-kit");
    const listed = (await mockRequest("GET", "/api/plugins")) as Array<{ id: string; status: string }>;
    expect(listed.find((plugin) => plugin.id === "lint-kit")?.status).toBe("disabled");
    await expect(mockRequest("POST", "/api/plugins/install", {})).rejects.toMatchObject({ status: 400 });
  });

  it("saves the user-owned sandbox keys only in user scope", async () => {
    await expect(
      mockRequest("PUT", "/api/config", { key: "additionalDirectories", value: ["/tmp/shared"] }),
    ).rejects.toMatchObject({ status: 400 });
    let cfg = (await mockRequest("PUT", "/api/config", {
      key: "additionalDirectories",
      value: ["/tmp/shared", "~/libs"],
      global: true,
    })) as ServerConfig;
    expect(cfg.additionalDirectories).toEqual(["/tmp/shared", "~/libs"]);
    await expect(
      mockRequest("PUT", "/api/config", { key: "additionalDirectories", value: ["relative"], global: true }),
    ).rejects.toMatchObject({ status: 400 });
    cfg = (await mockRequest("PUT", "/api/config", {
      key: "sandboxNetwork",
      value: { allowedDomains: [], deniedDomains: [] },
      global: true,
    })) as ServerConfig;
    // An empty allowlist is a real policy (no domain), not the absence of one.
    expect(cfg.sandboxNetwork).toEqual({ allowedDomains: [] });
    cfg = (await mockRequest("PUT", "/api/config", {
      key: "sandboxNetwork",
      value: null,
      global: true,
    })) as ServerConfig;
    expect(cfg.sandboxNetwork).toBeUndefined();
    cfg = (await mockRequest("PUT", "/api/config", {
      key: "additionalDirectories",
      value: [],
      global: true,
    })) as ServerConfig;
    expect(cfg.additionalDirectories).toBeUndefined();
  });

  it("accepts every shared reasoning effort and clears it with an empty value", async () => {
    for (const effort of ["low", "medium", "high", "max"]) {
      const cfg = (await mockRequest("PUT", "/api/config", { key: "reasoningEffort", value: effort })) as ServerConfig;
      expect(cfg.reasoningEffort).toBe(effort);
    }
    await expect(mockRequest("PUT", "/api/config", { key: "reasoningEffort", value: "xhigh" })).rejects.toMatchObject({
      status: 400,
    });
    const cleared = (await mockRequest("PUT", "/api/config", { key: "reasoningEffort", value: "" })) as ServerConfig;
    expect(cleared.reasoningEffort).toBeNull();
  });

  it("reports what a rewind cannot undo", async () => {
    const rewound = (await mockRequest("POST", "/api/rewind", { sessionId: "s-20260610-a1b2" })) as RewindResult;
    expect(rewound.warnings?.length).toBeGreaterThan(0);
  });
});
