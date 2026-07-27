import { mkdtempSync, rmSync } from "node:fs";
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
        { id: "a", task: "a", verifyCommand: "pass", options: { verify: async () => ({ code: 0, output: "ok" }) } },
        {
          id: "b",
          task: "b",
          verifyCommand: "fail",
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
    ).rejects.toThrow(/same workspace/);
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
});
