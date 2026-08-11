/**
 * `isRetainedWorktreeWorkspace` is the one owner of the "is this a retained
 * `.seekforge/worktrees/<slug>` checkout" path shape. The engine gates
 * `rollbackOnRegression` on it and the TUI pre-flights `/loop
 * --rollback-regressions` with it (apps/tui/src/__tests__/worktree-cmd.test.ts
 * imports the same export). These tests pin the two together: whatever the
 * predicate rejects, the engine must refuse before it takes a lease.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { runAutoLoop } from "../../src/agent/auto-loop.js";
import { isRetainedWorktreeWorkspace } from "../../src/worktree.js";

const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async (_call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
};

function deps(): AgentCoreDeps {
  const provider = {
    model: "flash",
    async chat(): Promise<ChatResponse> {
      throw new Error("the workspace is not isolated, so the engine must never reach the provider");
    },
    chatStream(): Promise<ChatResponse> {
      return this.chat();
    },
  };
  return { provider, dispatcher: noopDispatcher, confirm: async () => true };
}

describe("isRetainedWorktreeWorkspace", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "seekforge-retained-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("accepts a retained checkout and anything nested inside it", () => {
    expect(isRetainedWorktreeWorkspace(join(root, ".seekforge", "worktrees", "loop-1"))).toBe(true);
    expect(isRetainedWorktreeWorkspace(join(root, ".seekforge", "worktrees", "loop-1", "packages", "core"))).toBe(true);
  });

  it("rejects the main checkout, lookalikes and traversal back out", () => {
    for (const relative of [
      ".",
      ".seekforge",
      join(".seekforge", "sessions"),
      "worktrees",
      join("worktrees", "loop-1"),
      join("seekforge", "worktrees", "loop-1"),
      join(".seekforge", "worktrees", "loop-1", "..", ".."),
    ]) {
      expect(isRetainedWorktreeWorkspace(join(root, relative))).toBe(false);
    }
  });

  it("gates rollbackOnRegression on exactly the paths the predicate rejects", async () => {
    expect(isRetainedWorktreeWorkspace(root)).toBe(false);
    await expect(
      runAutoLoop(deps(), {
        task: "make it green",
        workspace: root,
        verifyCommand: "echo test",
        verify: async () => ({ code: 0, output: "ok" }),
        rollbackOnRegression: true,
      }),
    ).rejects.toThrow(/rollbackOnRegression requires a retained \.seekforge\/worktrees workspace/);
    // The refusal is part of the pure prologue: no lease, no state, no writes.
    expect(readdirSync(root)).toEqual([]);
  });
});
