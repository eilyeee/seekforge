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
  });
});
