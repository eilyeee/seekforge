import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { runLoopDag } from "../../src/agent/loop-dag.js";

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
    await expect(
      runLoopDag(deps, {
        workspace,
        nodes: [
          { id: "a", task: "a", verifyCommand: "test", dependsOn: ["b"] },
          { id: "b", task: "b", verifyCommand: "test", dependsOn: ["a"] },
        ],
      }),
    ).rejects.toThrow(/cycle/);
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
  });

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
  });

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
