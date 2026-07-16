import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionPolicy } from "@seekforge/shared";
import { createDefaultDispatcher, type ToolContext } from "../../src/tools/index.js";

const policy: PermissionPolicy = { approvalMode: "auto", mode: "edit", commandAllowlist: [] };

describe("git_commit", () => {
  let workspace: string;

  const ctx = (): ToolContext => ({ sessionId: "t", workspace, policy, confirm: async () => true });
  const dispatcher = createDefaultDispatcher();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace }).toString();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-git-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@test.local"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("stages and commits changes, returning the short hash", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello\n");
    const res = await dispatcher.execute(
      { id: "1", name: "git_commit", arguments: { message: "feat: add a.txt" } },
      ctx(),
    );
    expect(res.ok).toBe(true);
    expect((res.data as { commit: string }).commit).toMatch(/^[0-9a-f]{7,}$/);
    expect(git("log", "--oneline")).toContain("feat: add a.txt");
    expect(git("status", "--porcelain")).toBe("");
  });

  it("reports nothing_to_commit on a clean tree", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    await dispatcher.execute({ id: "1", name: "git_commit", arguments: { message: "init" } }, ctx());
    const res = await dispatcher.execute({ id: "2", name: "git_commit", arguments: { message: "empty" } }, ctx());
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("nothing_to_commit");
  });

  it("is blocked in ask mode", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    const askCtx: ToolContext = { ...ctx(), policy: { ...policy, mode: "ask" } };
    const res = await dispatcher.execute({ id: "1", name: "git_commit", arguments: { message: "nope" } }, askCtx);
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden_in_ask_mode");
  });
});
