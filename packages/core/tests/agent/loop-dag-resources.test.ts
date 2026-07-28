import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveLoopDagResources,
  inspectLoopDagResources,
  promoteLoopDagResult,
  pruneLoopDagResources,
} from "../../src/agent/loop-dag-resources.js";
import { runLoopDag } from "../../src/agent/loop-dag.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

const deps: AgentCoreDeps = {
  provider: {
    model: "test",
    async chat(): Promise<ChatResponse> {
      return {
        content: "done",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.001 },
        finishReason: "stop",
      };
    },
    async chatStream(): Promise<ChatResponse> {
      return this.chat({ messages: [] });
    },
  },
  dispatcher: { list: () => [], execute: async () => ({ ok: true }) },
  confirm: async () => true,
};

describe("Loop DAG resources", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("inspects, promotes, archives, and prunes managed worktrees", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-dag-resources-"));
    roots.push(root);
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "loop-test@seekforge.local"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Loop Test"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
    await runLoopDag(deps, {
      workspace: root,
      dagId: "resources",
      managedWorktrees: true,
      nodes: [
        {
          id: "node",
          task: "create output",
          verifyCommand: "custom",
          verifierId: "resource-v1",
          options: {
            verify: async (workspace) => {
              writeFileSync(join(workspace, "output.txt"), "done\n");
              return { code: 0, output: "ok" };
            },
          },
        },
      ],
    });
    const inspected = await inspectLoopDagResources(root, "resources");
    expect(inspected).toMatchObject({
      completed: true,
      archived: false,
      worktrees: [{ branch: expect.stringMatching(/^seekforge\//) }],
    });
    await promoteLoopDagResult(root, "resources", "node");
    expect(existsSync(join(root, "output.txt"))).toBe(true);
    expect(archiveLoopDagResources(root, "resources")).toMatchObject({ dagId: "resources" });
    const scratch = join(inspected.worktrees[0]!.path, "scratch.txt");
    writeFileSync(scratch, "uncommitted\n");
    expect((await pruneLoopDagResources(root, "resources")).retained).toHaveLength(1);
    rmSync(scratch);
    expect((await pruneLoopDagResources(root, "resources")).removed).toHaveLength(1);
  }, 30_000);

  it("reports zero retained resources for a completed non-managed DAG", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-dag-resources-"));
    roots.push(root);
    await runLoopDag(deps, {
      workspace: root,
      dagId: "no-worktrees",
      nodes: [
        {
          id: "node",
          task: "verify",
          verifyCommand: "custom",
          verifierId: "resource-v1",
          options: { verify: async () => ({ code: 0, output: "ok" }) },
        },
      ],
    });
    await expect(inspectLoopDagResources(root, "no-worktrees")).resolves.toMatchObject({
      totalBytes: 0,
      worktrees: [],
    });
    archiveLoopDagResources(root, "no-worktrees");
    await expect(pruneLoopDagResources(root, "no-worktrees")).resolves.toEqual({
      dagId: "no-worktrees",
      dryRun: false,
      removed: [],
      retained: [],
    });
  });
});
