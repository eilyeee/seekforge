import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHookableTool, matchTool, runHook } from "../../src/hooks/index.js";

describe("matchTool", () => {
  it("matches everything with *", () => {
    expect(matchTool("*", "run_command")).toBe(true);
    expect(matchTool("*", "anything")).toBe(true);
  });

  it("matches by prefix with trailing *", () => {
    expect(matchTool("git_*", "git_status")).toBe(true);
    expect(matchTool("git_*", "git_")).toBe(true);
    expect(matchTool("git_*", "grep")).toBe(false);
  });

  it("matches exact names otherwise", () => {
    expect(matchTool("run_command", "run_command")).toBe(true);
    expect(matchTool("run_command", "read_file")).toBe(false);
  });
});

describe("isHookableTool", () => {
  it("excludes pure-meta synthetic tools", () => {
    expect(isHookableTool("update_plan")).toBe(false);
    expect(isHookableTool("agent_result")).toBe(false);
    expect(isHookableTool("task_output")).toBe(false);
  });
  it("includes real tools and dispatch family", () => {
    expect(isHookableTool("run_command")).toBe(true);
    expect(isHookableTool("dispatch_agent")).toBe(true);
    expect(isHookableTool("agent_send")).toBe(true);
  });
});

describe("runHook", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "seekforge-hook-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("captures exit code and stdout/stderr", async () => {
    const out = await runHook(
      { command: "echo hello; echo oops 1>&2; exit 3" },
      { event: "preToolUse", toolName: "run_command" },
      cwd,
    );
    expect(out.exitCode).toBe(3);
    expect(out.stdout.trim()).toBe("hello");
    expect(out.stderr.trim()).toBe("oops");
  });

  it("returns exit 0 for a passing hook", async () => {
    const out = await runHook({ command: "exit 0" }, { event: "preToolUse", toolName: "x" }, cwd);
    expect(out.exitCode).toBe(0);
  });

  it("passes the payload as JSON on stdin", async () => {
    const file = join(cwd, "payload.json");
    const out = await runHook(
      { command: `cat > ${JSON.stringify(file)}` },
      { event: "postToolUse", toolName: "read_file", args: { path: "a.ts" } },
      cwd,
    );
    expect(out.exitCode).toBe(0);
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written.event).toBe("postToolUse");
    expect(written.toolName).toBe("read_file");
    expect(written.args).toEqual({ path: "a.ts" });
  });

  it("exposes SEEKFORGE_HOOK_EVENT and SEEKFORGE_TOOL_NAME in the env", async () => {
    const out = await runHook(
      { command: 'echo "$SEEKFORGE_HOOK_EVENT/$SEEKFORGE_TOOL_NAME"' },
      { event: "preToolUse", toolName: "git_commit" },
      cwd,
    );
    expect(out.stdout.trim()).toBe("preToolUse/git_commit");
  });

  it("kills a slow hook on timeout with a non-zero exit", async () => {
    const out = await runHook({ command: "sleep 30" }, { event: "preToolUse", toolName: "x" }, cwd);
    expect(out.exitCode).not.toBe(0);
    expect(out.stderr).toContain("timed out");
  }, 15_000);

  it("caps very large stdout", async () => {
    const out = await runHook(
      { command: "head -c 50000 /dev/zero | tr '\\0' 'a'" },
      { event: "preToolUse", toolName: "x" },
      cwd,
    );
    expect(out.stdout.length).toBeLessThanOrEqual(10_000);
  });
});
