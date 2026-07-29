import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { listLoopDagStates, loadLoopDagState, runLoopDag } from "../../src/agent/loop-dag.js";
import { listGitWorktrees } from "../../src/worktree.js";

const usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.001 };
const deps: AgentCoreDeps = {
  provider: {
    model: "test",
    async chat(): Promise<ChatResponse> {
      return { content: "done", toolCalls: [], usage, finishReason: "stop" };
    },
    async chatStream(): Promise<ChatResponse> {
      return this.chat({ messages: [] });
    },
  },
  dispatcher: { list: () => [], execute: async () => ({ ok: true }) },
  confirm: async () => true,
};

describe("runLoopDag", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("rejects malformed fan-in branch provenance and sorts offset timestamps by epoch", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-state-"));
    workspaces.push(workspace);
    const directory = join(workspace, ".seekforge", "loop-dags");
    mkdirSync(directory, { recursive: true });
    const state = (dagId: string, updatedAt: string, branch?: string) => ({
      schemaVersion: 1,
      dagId,
      fingerprint: "a".repeat(64),
      spentCost: 0,
      spentTokens: 0,
      results: [],
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
      ...(branch ? { fanIn: { status: "passed", workspace, branch, updatedAt: "2026-01-01T00:00:00.000Z" } } : {}),
    });
    writeFileSync(
      join(directory, "invalid-fan.json"),
      JSON.stringify(state("invalid-fan", "2026-01-01T00:00:00Z", "seekforge/a/b")),
    );
    writeFileSync(join(directory, "offset-old.json"), JSON.stringify(state("offset-old", "2026-01-01T00:30:00+01:00")));
    writeFileSync(join(directory, "utc-new.json"), JSON.stringify(state("utc-new", "2026-01-01T00:00:00Z")));

    expect(loadLoopDagState(workspace, "invalid-fan")).toBeNull();
    expect(listLoopDagStates(workspace).map((item) => item.dagId)).toEqual(["utc-new", "offset-old"]);
    expect(loadLoopDagState(workspace, "utc-new")).toMatchObject({ schemaVersion: 2, elapsedMs: 0 });
  });

  it("runs ready dependencies and skips descendants of failures", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    const results = await runLoopDag(deps, {
      workspace,
      nodes: [
        {
          id: "a",
          task: "a",
          verifyCommand: "pass",
          verifierId: "pass-v1",
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
        {
          id: "b",
          task: "b",
          verifyCommand: "fail",
          verifierId: "fail-v1",
          dependsOn: ["a"],
          options: {
            maxIterations: 1,
            maxNoProgressRecoveries: 0,
            verify: async () => ({ code: 1, output: "bad" }),
          },
        },
        { id: "c", task: "c", verifyCommand: "pass", dependsOn: ["b"] },
      ],
    });
    expect(results.map(({ id, status }) => [id, status])).toEqual([
      ["a", "passed"],
      ["b", "failed"],
      ["c", "skipped"],
    ]);
  });

  it("rejects cycles and unsafe unisolated concurrency", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    await expect(
      runLoopDag(deps, {
        workspace,
        maxConcurrency: 2,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/isolation/);
    await expect(
      runLoopDag(deps, {
        workspace,
        maxConcurrency: 2,
        workspaceForNode: () => workspace,
        nodes: [
          { id: "a", task: "a", verifyCommand: "test" },
          { id: "b", task: "b", verifyCommand: "test" },
        ],
      }),
    ).rejects.toThrow(/distinct workspaces/);
    mkdirSync(join(workspace, "parent", "child"), { recursive: true });
    await expect(
      runLoopDag(deps, {
        workspace,
        maxConcurrency: 2,
        workspaceForNode: (node) => join(workspace, node.id === "a" ? "parent" : "parent/child"),
        nodes: [
          { id: "a", task: "a", verifyCommand: "test" },
          { id: "b", task: "b", verifyCommand: "test" },
        ],
      }),
    ).rejects.toThrow(/non-overlapping/);
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "sparse-rerun",
        resume: true,
        rerunFrom: new Array(1),
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/unique existing node ids/);
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "cycle-before-side-effects",
        nodes: [
          { id: "a", task: "a", verifyCommand: "test", dependsOn: ["b"] },
          { id: "b", task: "b", verifyCommand: "test", dependsOn: ["a"] },
        ],
      }),
    ).rejects.toThrow(/cycle/);
    expect(loadLoopDagState(workspace, "cycle-before-side-effects")).toBeNull();
    await expect(
      runLoopDag(deps, {
        workspace,
        maxConcurrency: 9,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/1 to 8/);
    await expect(
      runLoopDag(deps, {
        workspace,
        costBudgetUsd: Number.NaN,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/positive and finite/);
    await expect(
      runLoopDag(deps, {
        workspace,
        maxDurationMs: 0.5,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/positive safe integer/);
    await expect(
      runLoopDag(deps, {
        workspace,
        managedWorktrees: { integrateDependencies: "yes" } as never,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/managedWorktrees configuration is invalid/);
    await expect(
      runLoopDag(deps, {
        workspace,
        fanIn: null as never,
        nodes: [{ id: "a", task: "a", verifyCommand: "test" }],
      }),
    ).rejects.toThrow(/fanIn configuration is invalid/);
  });

  it("creates isolated managed worktrees and integrates dependency commits", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-managed-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
    let fanInStatus = "";
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      maxConcurrency: 2,
      managedWorktrees: true,
      fanIn: { verifyCommand: "test -f produced.txt", maxIterations: 1 },
      onFanIn: (result) => {
        fanInStatus = result.status;
      },
      nodes: [
        {
          id: "producer",
          task: "produce",
          verifyCommand: "custom",
          options: {
            verify: async (nodeWorkspace) => {
              writeFileSync(join(nodeWorkspace, "produced.txt"), "ready\n");
              return { code: 0, output: "ok" };
            },
          },
        },
        {
          id: "consumer",
          task: "consume",
          verifyCommand: "custom",
          dependsOn: ["producer"],
          options: {
            verify: async (nodeWorkspace) => ({
              code: existsSync(join(nodeWorkspace, "produced.txt")) ? 0 : 1,
              output: "dependency checked",
            }),
          },
        },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(fanInStatus).toBe("passed");
    expect(results[0]?.output?.artifacts?.some((artifact) => artifact.startsWith("seekforge/"))).toBe(true);
    expect(await listGitWorktrees(workspace)).toHaveLength(4);
  }, 30_000);

  it("fan-in merges every node when dependency integration is disabled and isolates observer failures", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-fanin-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      managedWorktrees: { integrateDependencies: false },
      fanIn: { verifyCommand: "test -f upstream.txt && test -f downstream.txt", maxIterations: 1 },
      onFanIn: () => {
        throw new Error("observer failure");
      },
      nodes: [
        {
          id: "upstream",
          task: "upstream",
          verifyCommand: "custom",
          options: {
            verify: async (nodeWorkspace) => {
              writeFileSync(join(nodeWorkspace, "upstream.txt"), "upstream\n");
              return { code: 0, output: "ok" };
            },
          },
        },
        {
          id: "downstream",
          task: "downstream",
          verifyCommand: "custom",
          dependsOn: ["upstream"],
          options: {
            verify: async (nodeWorkspace) => {
              writeFileSync(join(nodeWorkspace, "downstream.txt"), "downstream\n");
              return { code: 0, output: "ok" };
            },
          },
        },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
  }, 30_000);

  it("invalidates passed fan-in evidence when rerunning nodes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-fanin-resume-"));
    const moved = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-fanin-moved-"));
    workspaces.push(workspace, moved);
    writeFileSync(join(workspace, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
    let fanInRuns = 0;
    const nodes = [
      {
        id: "node",
        task: "node",
        verifyCommand: "custom",
        verifierId: "node-v1",
        options: { verify: async () => ({ code: 0, output: "ok" }) },
      },
    ];
    const common = {
      workspace,
      dagId: "fanin-rerun",
      managedWorktrees: true,
      fanIn: { verifyCommand: "true", maxIterations: 1 },
      nodes,
      onFanIn: () => {
        fanInRuns++;
      },
    };
    await runLoopDag(deps, common);
    await runLoopDag(deps, { ...common, resume: true, rerunFrom: ["node"] });
    expect(fanInRuns).toBe(2);
    expect(loadLoopDagState(workspace, "fanin-rerun")?.fanIn?.status).toBe("passed");
    const integration = (await listGitWorktrees(workspace)).find((entry) => entry.branch.includes("integration"));
    expect(integration).toBeDefined();
    execFileSync("git", ["worktree", "move", integration!.path, join(moved, "integration")], { cwd: workspace });
    await expect(runLoopDag(deps, { ...common, resume: true })).rejects.toThrow(/outside its expected path/);
  }, 30_000);

  it("accounts for failed fan-in work and preserves its bounded result", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-fanin-budget-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
    await runLoopDag(deps, {
      workspace,
      dagId: "fanin-budget",
      managedWorktrees: true,
      fanIn: { verifyCommand: "false", maxIterations: 1 },
      nodes: [
        {
          id: "node",
          task: "node",
          verifyCommand: "custom",
          verifierId: "node-v1",
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
      ],
    });
    const state = loadLoopDagState(workspace, "fanin-budget");
    expect(state?.fanIn?.status).toBe("failed");
    expect(state?.fanIn?.result?.status).not.toBe("passed");
    expect(state?.spentCost).toBe(state?.fanIn?.result?.costUsd);
    expect(state?.spentCost).toBeGreaterThan(0);
  }, 30_000);

  it("binds managed resumes to the exact worktree path and configuration", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-managed-resume-"));
    const moved = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-moved-"));
    workspaces.push(workspace, moved);
    writeFileSync(join(workspace, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: workspace });
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: workspace });
    const nodes = [
      {
        id: "node",
        task: "node",
        verifyCommand: "custom",
        verifierId: "node-v1",
        options: { verify: async () => ({ code: 0, output: "ok" }) },
      },
    ];
    await runLoopDag(deps, {
      workspace,
      dagId: "managed-resume",
      managedWorktrees: { integrateDependencies: true },
      nodes,
    });
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "managed-resume",
        managedWorktrees: { integrateDependencies: false },
        nodes,
        resume: true,
      }),
    ).rejects.toThrow(/does not match/);

    const managed = (await listGitWorktrees(workspace)).find((entry) => entry.branch.includes("managed-resume"));
    expect(managed).toBeDefined();
    const movedPath = join(moved, "node");
    execFileSync("git", ["worktree", "move", managed!.path, movedPath], { cwd: workspace });
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "managed-resume",
        managedWorktrees: { integrateDependencies: true },
        nodes,
        resume: true,
      }),
    ).rejects.toThrow(/outside its expected path/);
  }, 30_000);

  it("persists completed nodes and resumes without rerunning them", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    let verifies = 0;
    const nodes = [
      {
        id: "persisted",
        task: "done",
        verifyCommand: "pass",
        verifierId: "persisted-v1",
        options: {
          verify: async () => {
            verifies++;
            return { code: 0, output: "ok" };
          },
        },
      },
    ];
    const first = await runLoopDag(deps, { workspace, dagId: "resume-test", nodes });
    expect(first[0]).toMatchObject({ status: "passed", attempts: 1 });
    const resumed = await runLoopDag(deps, { workspace, dagId: "resume-test", nodes, resume: true });
    expect(resumed[0]).toMatchObject({ status: "passed", attempts: 1 });
    expect(verifies).toBe(1);
    expect(loadLoopDagState(workspace, "resume-test")?.completedAt).toEqual(expect.any(String));
    expect(listLoopDagStates(workspace).map((state) => state.dagId)).toContain("resume-test");
  });

  it("persists cumulative active duration without charging offline approval time", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-duration-"));
    workspaces.push(workspace);
    let clock = 10_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    const nodes = [
      {
        id: "before",
        task: "before",
        verifyCommand: "before",
        verifierId: "before-duration-v1",
        options: {
          verify: async () => {
            clock += 40;
            return { code: 0, output: "ok" };
          },
        },
      },
      {
        id: "approval",
        task: "approval",
        verifyCommand: "approval",
        verifierId: "approval-duration-v1",
        dependsOn: ["before"],
        requiresApproval: true,
        options: {
          verify: async () => {
            clock += 30;
            return { code: 0, output: "ok" };
          },
        },
      },
    ];
    try {
      await runLoopDag(deps, { workspace, dagId: "duration-resume", nodes, maxDurationMs: 60 });
      expect(loadLoopDagState(workspace, "duration-resume")).toMatchObject({
        schemaVersion: 2,
        elapsedMs: 40,
      });
      expect(loadLoopDagState(workspace, "duration-resume")).not.toHaveProperty("completedAt");
      clock += 1_000;
      const resumed = await runLoopDag(deps, {
        workspace,
        dagId: "duration-resume",
        nodes,
        maxDurationMs: 60,
        resume: true,
        approveNode: () => true,
      });
      expect(resumed.find((result) => result.id === "approval")?.status).toBe("failed");
      expect(loadLoopDagState(workspace, "duration-resume")?.elapsedMs).toBe(70);
    } finally {
      now.mockRestore();
    }
  });

  it("rejects a resume when a node resolves to a different physical workspace", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    const firstNodeWorkspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    const secondNodeWorkspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    workspaces.push(workspace, firstNodeWorkspace, secondNodeWorkspace);
    const nodes = [
      {
        id: "mapped",
        task: "mapped",
        verifyCommand: "pass",
        verifierId: "mapped-v1",
        options: { verify: async () => ({ code: 0, output: "ok" }) },
      },
    ];
    await runLoopDag(deps, {
      workspace,
      dagId: "workspace-bound",
      maxConcurrency: 2,
      workspaceForNode: () => firstNodeWorkspace,
      nodes,
    });
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "workspace-bound",
        maxConcurrency: 2,
        workspaceForNode: () => secondNodeWorkspace,
        nodes,
        resume: true,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("requires and fingerprints a stable identity for persisted custom verifiers", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    const node = {
      id: "custom",
      task: "custom",
      verifyCommand: "custom",
      options: { verify: async () => ({ code: 0, output: "ok" }) },
    };
    await expect(runLoopDag(deps, { workspace, dagId: "custom-verifier", nodes: [node] })).rejects.toThrow(
      /requires verifierId/,
    );
    await runLoopDag(deps, {
      workspace,
      dagId: "custom-verifier",
      nodes: [{ ...node, verifierId: "custom-v1" }],
    });
    await expect(
      runLoopDag(deps, {
        workspace,
        dagId: "custom-verifier",
        nodes: [{ ...node, verifierId: "custom-v2" }],
        resume: true,
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("retries failed nodes and lets continue-policy dependents run", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    let checks = 0;
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      nodes: [
        {
          id: "retry",
          task: "retry",
          verifyCommand: "test",
          maxRetries: 1,
          options: {
            maxIterations: 1,
            maxNoProgressRecoveries: 0,
            verify: async () => {
              checks++;
              return checks < 3 ? { code: 1, output: "bad" } : { code: 0, output: "ok" };
            },
          },
        },
        {
          id: "soft-fail",
          task: "soft",
          verifyCommand: "fail",
          failurePolicy: "continue",
          options: { maxIterations: 1, maxNoProgressRecoveries: 0, verify: async () => ({ code: 1, output: "bad" }) },
        },
        {
          id: "after-soft-fail",
          task: "after",
          verifyCommand: "pass",
          dependsOn: ["soft-fail"],
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
      ],
    });
    expect(results.map(({ id, status, attempts }) => [id, status, attempts])).toEqual([
      ["retry", "passed", 2],
      ["soft-fail", "failed", 1],
      ["after-soft-fail", "passed", 1],
    ]);
  }, 20_000);

  it("supports failure conditions and publishes bounded dependency outputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      nodes: [
        {
          id: "probe",
          task: "probe",
          verifyCommand: "fail",
          options: { maxIterations: 1, maxNoProgressRecoveries: 0, verify: async () => ({ code: 1, output: "bad" }) },
        },
        {
          id: "repair",
          task: "repair",
          verifyCommand: "pass",
          dependsOn: ["probe"],
          condition: { nodeId: "probe", status: "failed" },
          consumeDependencyOutputs: true,
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
      ],
    });
    expect(results[0]?.status).toBe("failed");
    expect(results[1]).toMatchObject({ status: "passed", output: { status: "passed", iterations: 0 } });
  });

  it("supports composite conditions, approval audit, and declared artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "report.json"), "{}\n");
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      approveNode: () => ({ approved: true, actor: "release-bot", reason: "policy passed" }),
      nodes: [
        {
          id: "probe",
          task: "probe",
          verifyCommand: "fail",
          failurePolicy: "continue",
          options: { maxIterations: 1, maxNoProgressRecoveries: 0, verify: async () => ({ code: 1, output: "bad" }) },
        },
        {
          id: "release",
          task: "release",
          verifyCommand: "pass",
          dependsOn: ["probe"],
          condition: { all: [{ nodeId: "probe", status: "failed" }, { not: { nodeId: "probe", status: "passed" } }] },
          requiresApproval: true,
          outputPaths: ["report.json"],
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
      ],
    });
    expect(results[1]).toMatchObject({
      status: "passed",
      approval: { actor: "release-bot", reason: "policy passed" },
      output: { artifacts: ["report.json"] },
    });
  });

  it("reschedules a fast node's dependent without waiting for an unrelated slow node", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    const fast = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    const slow = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    const dependent = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    workspaces.push(root, fast, slow, dependent);
    const order: string[] = [];
    const verify = (id: string, delay: number) => async () => {
      order.push(`${id}:start`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      order.push(`${id}:end`);
      return { code: 0, output: "ok" };
    };
    await runLoopDag(deps, {
      workspace: root,
      persist: false,
      maxConcurrency: 2,
      workspaceForNode: (node) => ({ fast, slow, dependent })[node.id]!,
      nodes: [
        { id: "fast", task: "fast", verifyCommand: "pass", options: { verify: verify("fast", 5) } },
        { id: "slow", task: "slow", verifyCommand: "pass", options: { verify: verify("slow", 80) } },
        {
          id: "dependent",
          task: "dependent",
          verifyCommand: "pass",
          dependsOn: ["fast"],
          options: { verify: verify("dependent", 5) },
        },
      ],
    });
    expect(order.indexOf("dependent:start")).toBeLessThan(order.indexOf("slow:end"));
  });

  it("pauses for approval and resumes approved nodes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    const node = {
      id: "release",
      task: "release",
      verifyCommand: "pass",
      verifierId: "release-v1",
      requiresApproval: true,
      options: { verify: async () => ({ code: 0, output: "ok" }) },
    };
    const waiting = await runLoopDag(deps, { workspace, dagId: "approval", nodes: [node] });
    expect(waiting[0]?.status).toBe("waiting_approval");
    const resumed = await runLoopDag(deps, {
      workspace,
      dagId: "approval",
      nodes: [node],
      resume: true,
      approveNode: () => true,
    });
    expect(resumed[0]?.status).toBe("passed");
  });

  it("persists approval before execution and resumes without asking again", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const node = {
      id: "release",
      task: "release",
      verifyCommand: "pass",
      verifierId: "release-persist-v1",
      requiresApproval: true,
      options: {
        verify: async () => {
          started();
          await gate;
          return { code: 0, output: "ok" };
        },
      },
    };
    const running = runLoopDag(deps, {
      workspace,
      dagId: "approval-persist",
      nodes: [node],
      approveNode: () => ({ approved: true, actor: "operator" }),
    });
    await startedPromise;
    const statePath = join(workspace, ".seekforge/loop-dags/approval-persist.json");
    expect(JSON.parse(readFileSync(statePath, "utf8")).results).toMatchObject([
      { id: "release", status: "approved", approval: { actor: "operator" } },
    ]);
    release();
    await expect(running).resolves.toMatchObject([{ status: "passed", approval: { actor: "operator" } }]);

    const completed = JSON.parse(readFileSync(statePath, "utf8"));
    completed.results = [
      { id: "release", status: "approved", approval: { approvedAt: new Date().toISOString(), actor: "operator" } },
    ];
    delete completed.completedAt;
    writeFileSync(statePath, JSON.stringify(completed));
    const resumed = await runLoopDag(deps, {
      workspace,
      dagId: "approval-persist",
      nodes: [{ ...node, options: { verify: async () => ({ code: 0, output: "ok" }) } }],
      resume: true,
      approveNode: () => {
        throw new Error("approval should have been restored");
      },
    });
    expect(resumed).toMatchObject([{ status: "passed", approval: { actor: "operator" } }]);
  });

  it("invalidates a resumed node and all downstream results", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    let verifies = 0;
    const verify = async () => {
      verifies++;
      return { code: 0, output: "ok" };
    };
    const nodes = [
      { id: "a", task: "a", verifyCommand: "pass", verifierId: "a-v1", options: { verify } },
      {
        id: "b",
        task: "b",
        verifyCommand: "pass",
        verifierId: "b-v1",
        dependsOn: ["a"],
        options: { verify },
      },
    ];
    await runLoopDag(deps, { workspace, dagId: "rerun", nodes });
    expect(verifies).toBe(2);
    await runLoopDag(deps, { workspace, dagId: "rerun", nodes, resume: true, rerunFrom: ["a"] });
    expect(verifies).toBe(4);
  });

  it("serializes nodes that share an exclusive resource", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    const first = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    const second = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-node-"));
    workspaces.push(workspace, first, second);
    let active = 0;
    let maximumActive = 0;
    const verify = async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { code: 0, output: "ok" };
    };
    const results = await runLoopDag(deps, {
      workspace,
      persist: false,
      maxConcurrency: 2,
      workspaceForNode: (node) => (node.id === "a" ? first : second),
      nodes: [
        { id: "a", task: "a", verifyCommand: "pass", resources: ["release"], options: { verify } },
        { id: "b", task: "b", verifyCommand: "pass", resources: ["release"], options: { verify } },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(maximumActive).toBe(1);
  });

  it("does not treat dots in distinct workspace paths as logical resource hierarchy", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    const first = join(workspace, "pkg");
    const second = join(workspace, "pkg.child");
    mkdirSync(first);
    mkdirSync(second);
    workspaces.push(workspace);
    let active = 0;
    let maximumActive = 0;
    const verify = async () => {
      active++;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return { code: 0, output: "ok" };
    };
    await runLoopDag(deps, {
      workspace,
      persist: false,
      maxConcurrency: 2,
      workspaceForNode: (node) => (node.id === "a" ? first : second),
      nodes: [
        { id: "a", task: "a", verifyCommand: "pass", options: { verify } },
        { id: "b", task: "b", verifyCommand: "pass", options: { verify } },
      ],
    });
    expect(maximumActive).toBe(2);
  });

  it("clears stale completion when a resumed graph pauses for approval", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-dag-"));
    workspaces.push(workspace);
    const node = {
      id: "release",
      task: "release",
      verifyCommand: "pass",
      verifierId: "release-v1",
      requiresApproval: true,
      options: { verify: async () => ({ code: 0, output: "ok" }) },
    };
    await runLoopDag(deps, {
      workspace,
      dagId: "approval-completion",
      nodes: [node],
      approveNode: () => true,
    });
    const completedPath = join(workspace, ".seekforge/loop-dags/approval-completion.json");
    expect(JSON.parse(readFileSync(completedPath, "utf8")).completedAt).toEqual(expect.any(String));
    await runLoopDag(deps, {
      workspace,
      dagId: "approval-completion",
      nodes: [node],
      resume: true,
      rerunFrom: ["release"],
    });
    expect(JSON.parse(readFileSync(completedPath, "utf8")).completedAt).toBeUndefined();
  });
});
