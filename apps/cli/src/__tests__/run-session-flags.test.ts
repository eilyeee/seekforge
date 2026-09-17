/**
 * The run path's new flags, end to end through runTaskCommand with a scripted
 * agent: --session-id and --fork-session reach core, --agents reaches the
 * roster, --json-schema produces (or fails to produce) structured output, and
 * conflicting flags are refused before anything runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  loadConfig: () => ({ apiKey: "test-key", model: "deepseek-v4-flash" }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

const { state } = vi.hoisted(() => ({
  state: {
    inputs: [] as Array<Record<string, unknown>>,
    subagentIds: [] as string[],
    structuredReplies: [] as string[],
    forks: [] as string[],
  },
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    buildProvider: () => ({
      model: "fake",
      chat: async () => ({
        content: state.structuredReplies.shift() ?? "{}",
        usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.5 },
      }),
    }),
    forkSession: (_workspace: string, id: string) => {
      state.forks.push(id);
      return `${id}-fork`;
    },
    readSessionMeta: (_workspace: string, id: string) =>
      id.startsWith("existing")
        ? { id, task: "t", mode: "ask", status: "completed", createdAt: "x", updatedAt: "x" }
        : undefined,
  };
});

vi.mock("../agent-factory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCliAgent: (opts: { subagents?: Array<{ id: string }> }) => {
    state.subagentIds = (opts.subagents ?? []).map((agent) => agent.id);
    return {
      agent: {
        runTask: async function* (input: Record<string, unknown>) {
          state.inputs.push(input);
          const sessionId = (input.resumeSessionId as string | undefined) ?? (input.sessionId as string) ?? "generated";
          yield { type: "session.created", sessionId };
          yield {
            type: "session.completed",
            report: {
              summary: "did it",
              changedFiles: ["a.ts"],
              commandsRun: [],
              verification: "none",
              usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 1 },
            },
          };
        },
      },
      dispose: () => {},
    };
  },
}));

const { runTaskCommand } = await import("../commands/run.js");

describe("runTaskCommand session and output flags", () => {
  let cwd: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "sf-run-flags-"));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      out.push(args.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      err.push(args.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      err.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    state.inputs = [];
    state.subagentIds = [];
    state.structuredReplies = [];
    state.forks = [];
    rmSync(cwd, { recursive: true, force: true });
  });

  it("starts the session under --session-id", async () => {
    expect(await runTaskCommand("task", { mode: "edit", sessionId: "chosen-id", outputFormat: "json" })).toBe(true);
    expect(state.inputs[0]).toMatchObject({ sessionId: "chosen-id", resumeSessionId: undefined });
    expect(JSON.parse(out.join("\n"))).toMatchObject({ session_id: "chosen-id" });
  });

  it("forks a resumed session and continues the fork in its stored mode", async () => {
    expect(
      await runTaskCommand("task", {
        mode: "edit",
        resumeSessionId: "existing-1",
        forkSession: true,
        outputFormat: "json",
      }),
    ).toBe(true);
    expect(state.forks).toEqual(["existing-1"]);
    expect(state.inputs[0]).toMatchObject({ resumeSessionId: "existing-1-fork", mode: "ask" });
    expect(state.inputs[0]).not.toHaveProperty("sessionId");
    expect(err.join("")).toContain("existing-1-fork");
  });

  it("adds --agents to the roster", async () => {
    await runTaskCommand("task", {
      mode: "edit",
      agentsJson: '{"my-agent":{"description":"d","prompt":"p"}}',
      suppressResult: true,
      outputFormat: "json",
    });
    expect(state.subagentIds).toContain("my-agent");
    expect(state.subagentIds).toContain("reviewer");
  });

  it("passes prompt files to core", async () => {
    await runTaskCommand("task", {
      mode: "edit",
      systemPrompt: "REPLACED",
      appendSystemPrompt: "MORE",
      outputFormat: "json",
      suppressResult: true,
    });
    expect(state.inputs[0]).toMatchObject({ systemPromptOverride: "REPLACED\n\nMORE" });
    expect(state.inputs[0]).not.toHaveProperty("appendSystemPrompt");
  });

  it("emits a validated structured_output and counts its cost", async () => {
    state.structuredReplies = ['{"files": "one"}', '{"files": 1}'];
    const ok = await runTaskCommand("task", {
      mode: "edit",
      outputFormat: "json",
      jsonSchema: '{"type":"object","required":["files"],"properties":{"files":{"type":"integer"}}}',
    });
    expect(ok).toBe(true);
    expect(process.exitCode).toBeUndefined();
    const envelope = JSON.parse(out.join("\n"));
    expect(envelope).toMatchObject({ subtype: "success", structured_output: { files: 1 }, total_cost_usd: 2 });
  });

  it("prints only the structured value in text mode", async () => {
    state.structuredReplies = ['{"files": 2}'];
    await runTaskCommand("task", {
      mode: "edit",
      outputFormat: "text",
      jsonSchema: '{"type":"object"}',
    });
    expect(out.at(-1)).toBe('{\n  "files": 2\n}');
  });

  it("fails with Claude Code's subtype when the value never validates", async () => {
    state.structuredReplies = ["[]", "[]", "[]"];
    const ok = await runTaskCommand("task", {
      mode: "edit",
      outputFormat: "stream-json",
      jsonSchema: '{"type":"object"}',
    });
    expect(ok).toBe(false);
    expect(process.exitCode).toBe(1);
    const result = JSON.parse(out.at(-1) ?? "{}");
    expect(result).toMatchObject({ type: "result", subtype: "error_max_structured_output_retries", is_error: true });
    expect(result).not.toHaveProperty("structured_output");
    expect(err.join("")).toContain("after 3 attempt(s)");
  });

  it("does not spend on structured output once the budget is used up", async () => {
    state.structuredReplies = ['{"files": 1}'];
    const ok = await runTaskCommand("task", {
      mode: "edit",
      outputFormat: "json",
      maxCostUsd: 0.5,
      jsonSchema: '{"type":"object"}',
    });
    expect(ok).toBe(false);
    expect(state.structuredReplies).toHaveLength(1);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ subtype: "error_max_structured_output_retries" });
    expect(err.join("")).toContain("was not produced");
  });

  it.each([
    [{ worktree: true, continueLast: true }, "--worktree"],
    [{ worktree: "x", resumeSessionId: "existing-1" }, "--worktree"],
    [{ jsonSchema: "{}", inputFormat: "stream-json" }, "--input-format stream-json"],
    [{ sessionId: "existing-2" }, "already exists"],
    [{ agentsJson: "[]" }, "--agents"],
  ])("refuses %o before running", async (flags, message) => {
    const before = process.listeners("SIGINT");
    expect(await runTaskCommand("task", { mode: "edit", ...flags })).toBe(false);
    expect(state.inputs).toHaveLength(0);
    expect(state.forks).toHaveLength(0);
    expect(err.join("")).toContain(message);
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("reports a worktree that cannot be created without running anything", async () => {
    expect(await runTaskCommand("task", { mode: "edit", worktree: true })).toBe(false);
    expect(state.inputs).toHaveLength(0);
    expect(err.join("")).toContain("could not create the worktree");
  });
});
