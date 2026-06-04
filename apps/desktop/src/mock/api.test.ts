import { describe, expect, it } from "vitest";
import { mockRequest } from "./api";
import type {
  CompactResult,
  DoctorReport,
  McpServer,
  MemoryStats,
  PruneResult,
  SessionMeta,
  Skill,
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
    })) as McpServer;
    expect(added.name).toBe("test-mcp");
    const removed = (await mockRequest("DELETE", "/api/mcp/test-mcp")) as { deleted: boolean };
    expect(removed.deleted).toBe(true);
  });

  it("rejects adding an MCP server with neither command nor url", async () => {
    await expect(mockRequest("POST", "/api/mcp", { name: "bad" })).rejects.toMatchObject({ status: 400 });
  });

  it("imports an agent from a path", async () => {
    const agent = (await mockRequest("POST", "/api/agents/import", { path: "/tmp/reviewer" })) as {
      id: string;
      scope: string;
    };
    expect(agent.scope).toBe("project");
  });

  it("returns a DoctorReport", async () => {
    const report = (await mockRequest("GET", "/api/doctor")) as DoctorReport;
    expect(typeof report.apiKeyConfigured).toBe("boolean");
    expect(report.nodeVersion).toMatch(/^v/);
    expect(report.modelCount).toBeGreaterThan(0);
  });
});

describe("mockRequest — config new keys", () => {
  it("accepts planModel / escalateOnFailure / memoryAutoApproveConfidence", async () => {
    await mockRequest("PUT", "/api/config", { key: "planModel", value: "deepseek-v4-pro" });
    await mockRequest("PUT", "/api/config", { key: "escalateOnFailure", value: "true" });
    const cfg = (await mockRequest("PUT", "/api/config", {
      key: "memoryAutoApproveConfidence",
      value: "0.9",
    })) as { planModel?: string; escalateOnFailure?: boolean; memoryAutoApproveConfidence?: number };
    expect(cfg.planModel).toBe("deepseek-v4-pro");
    expect(cfg.escalateOnFailure).toBe(true);
    expect(cfg.memoryAutoApproveConfidence).toBe(0.9);
  });
});
