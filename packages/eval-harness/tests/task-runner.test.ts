import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import type { AgentCoreDeps } from "@seekforge/core";
import { evaluateCheck, runTask } from "../src/task-runner.js";
import { FAKE_USAGE, completedEvents, fakeAgent, makeTask, makeTempFixture, type TempFixture } from "./helpers.js";

let fixtures: TempFixture[] = [];

function fixture(files: Record<string, string>): TempFixture {
  const fx = makeTempFixture(files);
  fixtures.push(fx);
  return fx;
}

afterEach(() => {
  for (const fx of fixtures) fx.cleanup();
  fixtures = [];
});

describe("evaluateCheck", () => {
  const fileChecks = () => fixture({ "notes.txt": "version v42 shipped", "sub/marker": "x" });

  it("file_contains passes on a regex match and fails otherwise", async () => {
    const fx = fileChecks();
    const ctx = { dir: fx.dir, answer: "" };
    const pass = await evaluateCheck({ type: "file_contains", path: "notes.txt", pattern: "v\\d+" }, ctx);
    expect(pass.passed).toBe(true);
    const fail = await evaluateCheck({ type: "file_contains", path: "notes.txt", pattern: "v\\d{5}" }, ctx);
    expect(fail.passed).toBe(false);
    expect(fail.detail).toContain("notes.txt");
    const missing = await evaluateCheck({ type: "file_contains", path: "nope.txt", pattern: "x" }, ctx);
    expect(missing.passed).toBe(false);
    expect(missing.detail).toContain("file not found");
  });

  it("file_not_contains fails when the pattern is present (and on a missing file)", async () => {
    const fx = fileChecks();
    const ctx = { dir: fx.dir, answer: "" };
    const pass = await evaluateCheck({ type: "file_not_contains", path: "notes.txt", pattern: "deprecated" }, ctx);
    expect(pass.passed).toBe(true);
    const fail = await evaluateCheck({ type: "file_not_contains", path: "notes.txt", pattern: "v4\\d" }, ctx);
    expect(fail.passed).toBe(false);
    expect(fail.detail).toContain("forbidden pattern");
    const missing = await evaluateCheck({ type: "file_not_contains", path: "nope.txt", pattern: "x" }, ctx);
    expect(missing.passed).toBe(false);
  });

  it("command_succeeds reflects the exit code and honors cwd", async () => {
    const fx = fileChecks();
    const ctx = { dir: fx.dir, answer: "" };
    const pass = await evaluateCheck({ type: "command_succeeds", command: "test -f notes.txt" }, ctx);
    expect(pass.passed).toBe(true);
    const fail = await evaluateCheck({ type: "command_succeeds", command: "exit 3" }, ctx);
    expect(fail.passed).toBe(false);
    expect(fail.detail).toContain("exit 3");
    const inSub = await evaluateCheck({ type: "command_succeeds", command: "test -f marker", cwd: "sub" }, ctx);
    expect(inSub.passed).toBe(true);
  });

  it("answer_matches tests the final answer against the regex", async () => {
    const ctx = { dir: "/nonexistent", answer: "Run npm test to execute the suite." };
    const pass = await evaluateCheck({ type: "answer_matches", pattern: "npm test|node --test" }, ctx);
    expect(pass.passed).toBe(true);
    const fail = await evaluateCheck({ type: "answer_matches", pattern: "pytest" }, ctx);
    expect(fail.passed).toBe(false);
  });
});

describe("runTask", () => {
  it("copies the fixture to an isolated git workspace; mutations never touch the source", async () => {
    const fx = fixture({ "file.txt": "original" });
    let sawGitRepo = false;
    const result = await runTask(
      makeTask({ checks: [{ type: "file_contains", path: "file.txt", pattern: "^mutated$" }] }),
      {
        fixturesDir: fx.fixturesDir,
        createAgent: fakeAgent((input) => {
          expect(input.projectPath).not.toBe(fx.dir);
          sawGitRepo = existsSync(join(input.projectPath, ".git"));
          writeFileSync(join(input.projectPath, "file.txt"), "mutated");
          return completedEvents();
        }),
      },
    );
    expect(sawGitRepo).toBe(true);
    expect(result.success).toBe(true);
    expect(readFileSync(join(fx.dir, "file.txt"), "utf8")).toBe("original");
  });

  it("removes the temp workspace by default and keeps it with keepDir", async () => {
    const fx = fixture({ "file.txt": "x" });
    let workspace = "";
    const opts = {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent((input) => {
        workspace = input.projectPath;
        return completedEvents();
      }),
    };
    await runTask(makeTask(), opts);
    expect(existsSync(workspace)).toBe(false);

    const kept = await runTask(makeTask(), { ...opts, keepDir: true });
    expect(kept.workspaceDir).toBeDefined();
    expect(existsSync(kept.workspaceDir as string)).toBe(true);
  });

  it("fails when the session does not complete, even if all checks pass", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const result = await runTask(makeTask({ checks: [{ type: "file_contains", path: "file.txt", pattern: "ok" }] }), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent(() => [
        { type: "session.created", sessionId: "s1" },
        { type: "session.failed", error: { code: "boom", message: "model exploded" } },
      ]),
    });
    expect(result.checks.every((c) => c.passed)).toBe(true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("fails when any check fails, even if the session completed", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const result = await runTask(
      makeTask({
        checks: [
          { type: "file_contains", path: "file.txt", pattern: "ok" },
          { type: "file_contains", path: "file.txt", pattern: "missing" },
        ],
      }),
      { fixturesDir: fx.fixturesDir, createAgent: fakeAgent(() => completedEvents()) },
    );
    expect(result.success).toBe(false);
    expect(result.checks.map((c) => c.passed)).toEqual([true, false]);
  });

  it("collects metrics from events and answer_matches uses the final summary", async () => {
    const fx = fixture({ "file.txt": "x" });
    const events: AgentEvent[] = [
      { type: "session.created", sessionId: "s1" },
      { type: "tool.started", toolName: "read_file", args: {} },
      { type: "tool.completed", toolName: "read_file", result: { ok: true } },
      { type: "tool.started", toolName: "run_command", args: {} },
      { type: "tool.completed", toolName: "run_command", result: { ok: false, error: { code: "x", message: "y" } } },
      {
        type: "session.completed",
        report: {
          summary: "Use npm test.",
          changedFiles: [],
          commandsRun: [],
          verification: "",
          usage: FAKE_USAGE,
        },
      },
    ];
    const result = await runTask(makeTask({ mode: "ask", checks: [{ type: "answer_matches", pattern: "npm test" }] }), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent(() => events),
    });
    expect(result.success).toBe(true);
    expect(result.metrics.toolCalls).toBe(2);
    expect(result.metrics.failedToolCalls).toBe(1);
    expect(result.metrics.costUsd).toBeCloseTo(FAKE_USAGE.costUsd);
    expect(result.metrics.promptTokens).toBe(100);
    expect(result.metrics.completionTokens).toBe(50);
    expect(result.metrics.cacheHitTokens).toBe(0);
    expect(result.metrics.totalTokens).toBe(150);
    expect(result.metrics.durationMs).toBeGreaterThanOrEqual(0);
    // No trace files written by the fake agent: score/turns are absent.
    expect(result.metrics.score).toBeUndefined();
    expect(result.metrics.turns).toBeUndefined();
  });

  it("records thrown streams as session errors", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const thrown = await runTask(makeTask(), {
      fixturesDir: fx.fixturesDir,
      createAgent: () => ({
        agent: {
          // biome-ignore lint/correctness/useYield: fake stream must throw before yielding any event — a yield would change the tested error path
          async *runTask() {
            throw new Error("transport closed");
          },
        },
      }),
    });
    expect(thrown.success).toBe(false);
    expect(thrown.error).toBe("transport closed");
  });

  it("records missing terminal events as session errors", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const missing = await runTask(makeTask(), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent(() => [{ type: "session.created", sessionId: "s1" }]),
    });
    expect(missing.error).toMatch(/without session\.completed/);
  });

  it("keeps the latest usage metrics when a session fails", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const result = await runTask(makeTask(), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent(() => [
        { type: "session.created", sessionId: "s1" },
        { type: "usage.updated", usage: FAKE_USAGE },
        { type: "session.failed", error: { code: "timeout", message: "late failure" } },
      ]),
    });
    expect(result.success).toBe(false);
    expect(result.metrics).toMatchObject({
      costUsd: FAKE_USAGE.costUsd,
      promptTokens: FAKE_USAGE.promptTokens,
      completionTokens: FAKE_USAGE.completionTokens,
      cacheHitTokens: FAKE_USAGE.cacheHitTokens,
      totalTokens: FAKE_USAGE.promptTokens + FAKE_USAGE.completionTokens,
    });
  });

  it("captures skill usage written by the agent into the workspace before cleanup", async () => {
    const fx = fixture({ "file.txt": "x" });
    const result = await runTask(makeTask({ checks: [{ type: "file_contains", path: "file.txt", pattern: "x" }] }), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent((input) => {
        const dir = join(input.projectPath, ".seekforge");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "skills-usage.jsonl"),
          `${JSON.stringify({ sessionId: "s1", skillId: "bugfix", scope: "builtin", score: 4 })}\n` +
            `${JSON.stringify({ sessionId: "s1", skillId: "verify-change", scope: "builtin", score: 2 })}\n`,
        );
        return completedEvents();
      }),
    });
    expect(result.skills.map((s) => s.skillId)).toEqual(["bugfix", "verify-change"]);
    expect(result.skills[0]).toEqual({ skillId: "bugfix", scope: "builtin", score: 4 });
  });

  it("reports an empty skills array when no usage file was written", async () => {
    const fx = fixture({ "file.txt": "x" });
    const result = await runTask(makeTask(), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent(() => completedEvents()),
    });
    expect(result.skills).toEqual([]);
  });

  it("scores the session via core scoreSession when trace files exist", async () => {
    const fx = fixture({ "file.txt": "x" });
    const result = await runTask(makeTask({ checks: [{ type: "file_contains", path: "file.txt", pattern: "x" }] }), {
      fixturesDir: fx.fixturesDir,
      createAgent: fakeAgent((input) => {
        const sessionDir = join(input.projectPath, ".seekforge", "sessions", "fake-session");
        mkdirSync(sessionDir, { recursive: true });
        const now = new Date().toISOString();
        writeFileSync(
          join(sessionDir, "session.json"),
          JSON.stringify({
            id: "fake-session",
            task: input.task,
            mode: "edit",
            status: "completed",
            createdAt: now,
            updatedAt: now,
            usage: FAKE_USAGE,
          }),
        );
        writeFileSync(
          join(sessionDir, "messages.jsonl"),
          `${JSON.stringify({ role: "assistant", content: "fixing" })}\n` +
            `${JSON.stringify({ role: "assistant", content: "fixed" })}\n`,
        );
        writeFileSync(
          join(sessionDir, "tool-calls.jsonl"),
          `${JSON.stringify({ toolName: "run_command", ok: true, args: { command: "npm test" } })}\n`,
        );
        return completedEvents();
      }),
    });
    expect(result.metrics.score).toBe(100);
    expect(result.metrics.turns).toBe(2);
  });

  it("runs a persisted loop and resumes it against the configured terminal states", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const calls: string[] = [];
    const result = await runTask(
      makeTask({
        runner: "loop",
        loop: {
          verifyCommand: "npm test",
          maxIterations: 1,
          expectedStatus: "passed",
          resume: { expectedInitialStatus: "exhausted", additionalIterations: 2 },
        },
        checks: [{ type: "file_contains", path: "file.txt", pattern: "ok" }],
      }),
      {
        fixturesDir: fx.fixturesDir,
        createAgent: () => ({
          agent: {
            async *runTask() {
              /* auto-loop owns the agent in production */
            },
          },
          deps: {} as AgentCoreDeps,
        }),
        runLoop: async (_deps, options) => {
          calls.push(`run:${options.verifyCommand}:${options.maxIterations}`);
          return {
            status: "exhausted",
            iterations: 1,
            costUsd: 0.01,
            sessionId: "s1",
            finalVerify: { code: 1, output: "red" },
            loopId: "loop-1",
          };
        },
        resumeLoop: async (_deps, loopId, options) => {
          calls.push(`resume:${loopId}:${options.additionalIterations}`);
          return {
            status: "passed",
            iterations: 2,
            costUsd: 0.02,
            sessionId: "s1",
            finalVerify: { code: 0, output: "green" },
            loopId,
          };
        },
      },
    );
    expect(calls).toEqual(["run:npm test:1", "resume:loop-1:2"]);
    expect(result.success).toBe(true);
    expect(result.execution).toMatchObject({
      runner: "loop",
      status: "passed",
      expectedStatus: "passed",
      iterations: 2,
      maxIterations: 3,
      resumed: true,
    });
    expect(result.metrics.costUsd).toBe(0.02);
  });

  it("binds session_scenario resume steps to the prior session and applies memory lifecycle actions", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const inputs: Array<{ task: string; resumeSessionId?: string }> = [];
    const result = await runTask(
      makeTask({
        runner: "session_scenario",
        scenario: {
          steps: [
            { type: "memory.add", key: "rule", content: "use stable ids", approve: false },
            { type: "memory.approve", key: "rule" },
            { type: "agent" },
            { type: "agent", task: "review it", resume: true },
          ],
        },
        checks: [
          { type: "memory_stats", field: "approved", equals: 1 },
          { type: "memory_stats", field: "pending", equals: 0 },
          { type: "memory_stats", field: "directAddedFacts", equals: 1 },
        ],
      }),
      {
        fixturesDir: fx.fixturesDir,
        createAgent: fakeAgent((input) => {
          inputs.push({
            task: input.task,
            ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
          });
          return completedEvents();
        }),
      },
    );
    expect(inputs).toEqual([{ task: "do the thing" }, { task: "review it", resumeSessionId: "fake-session" }]);
    expect(result.success).toBe(true);
    expect(result.execution).toMatchObject({ runner: "session_scenario", resumed: true, passed: true });
    expect(result.execution?.steps).toHaveLength(4);
    expect(result.metrics.costUsd).toBe(FAKE_USAGE.costUsd);
  });

  it("treats an explicitly expected failed terminal state as a successful scenario outcome", async () => {
    const fx = fixture({ "file.txt": "ok" });
    const result = await runTask(
      makeTask({
        expectedStatus: "failed",
        checks: [{ type: "file_contains", path: "file.txt", pattern: "ok" }],
      }),
      {
        fixturesDir: fx.fixturesDir,
        createAgent: fakeAgent(() => [
          { type: "session.created", sessionId: "expected-failure" },
          { type: "session.failed", error: { code: "expected", message: "deliberate" } },
        ]),
      },
    );
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.execution).toMatchObject({ status: "failed", expectedStatus: "failed", passed: true });
  });
});
