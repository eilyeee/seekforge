/**
 * The headless run path's wiring for --add-dir (the grant reaches core, not
 * only @-expansion) and the plan flow (an in-run approval is not asked again;
 * a read-only session never executes a plan).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";

const { state } = vi.hoisted(() => ({
  state: {
    agentOptions: [] as Array<Record<string, unknown>>,
    inputs: [] as Array<Record<string, unknown>>,
    sessionModes: new Map<string, "ask" | "edit">(),
    answers: [] as string[],
    questions: [] as string[],
  },
}));

vi.mock("../config.js", () => ({
  loadConfig: () => ({ apiKey: "test-key", model: "deepseek-v4-flash" }),
  resolveConfig: () => ({ config: { apiKey: "test-key", model: "deepseek-v4-flash" }, mcpOrigins: {} }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      state.questions.push(prompt);
      return state.answers.shift() ?? "";
    },
    close: () => {},
    on: () => {},
    once: () => {},
  }),
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    readSessionMeta: (_workspace: string, id: string) => {
      const mode = state.sessionModes.get(id);
      return mode ? { id, task: "t", mode, status: "completed", createdAt: "x", updatedAt: "x" } : undefined;
    },
  };
});

vi.mock("../agent-factory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCliAgent: (opts: Record<string, unknown>) => {
    state.agentOptions.push(opts);
    return {
      agent: {
        runTask: async function* (input: Record<string, unknown>) {
          state.inputs.push(input);
          const sessionId = (input.resumeSessionId as string | undefined) ?? "plan-session";
          yield { type: "session.created", sessionId };
          yield {
            type: "session.completed",
            report: {
              summary: "done",
              changedFiles: [],
              commandsRun: [],
              verification: "none",
              usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 },
            },
          };
        },
      },
      dispose: () => {},
    };
  },
}));

const { runTaskCommand, readOnlyConfirm, EXIT_PLAN_MODE_TOOL } = await import("../commands/run.js");

let cwd: string;
let outside: string;
let err: string[];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-run-plan-"));
  outside = mkdtempSync(join(tmpdir(), "sf-run-extra-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  err = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    err.push(args.join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  state.agentOptions = [];
  state.inputs = [];
  state.sessionModes.clear();
  state.answers = [];
  state.questions = [];
  rmSync(cwd, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const planRequest: PermissionRequest = {
  toolName: EXIT_PLAN_MODE_TOOL,
  permission: "write",
  description: "Leave plan mode and implement this plan:\n\n1. step",
  sessionGrantable: false,
};

describe("--add-dir", () => {
  it("reaches core as additionalDirectories, skipping what is not a directory outside the project", async () => {
    expect(
      await runTaskCommand("task", {
        mode: "edit",
        outputFormat: "json",
        addDirs: [outside, outside, join(cwd, "sub-missing"), "."],
      }),
    ).toBe(true);
    expect(state.agentOptions[0]?.additionalDirectories).toEqual([realpathSync(outside)]);
    expect(err.filter((line) => line.includes("--add-dir")).length).toBe(2);
  });

  it("adds no grant when none is given", async () => {
    await runTaskCommand("task", { mode: "edit", outputFormat: "json" });
    expect(state.agentOptions[0]).not.toHaveProperty("additionalDirectories");
  });
});

describe("the plan flow", () => {
  it("does not ask again once the plan was approved inside the run", async () => {
    state.sessionModes.set("plan-session", "edit");
    expect(await runTaskCommand("task", { mode: "edit", plan: true })).toBe(true);
    expect(state.inputs).toHaveLength(1);
    expect(state.inputs[0]).toMatchObject({ mode: "ask", plan: true });
    expect(state.questions).toEqual([]);
  });

  it("asks, and executes on yes, when the plan run ended still in plan mode", async () => {
    state.sessionModes.set("plan-session", "ask");
    state.answers = ["y"];
    expect(await runTaskCommand("task", { mode: "edit", plan: true })).toBe(true);
    expect(state.questions).toHaveLength(1);
    expect(state.inputs.map((input) => input.mode)).toEqual(["ask", "edit"]);
    expect(state.inputs[1]).toMatchObject({ resumeSessionId: "plan-session" });
  });

  it("never executes a plan in a read-only session, nor lets exit_plan_mode switch it", async () => {
    state.sessionModes.set("plan-session", "ask");
    state.answers = ["y"];
    expect(await runTaskCommand("task", { mode: "ask", permissionMode: "plan" })).toBe(true);
    expect(state.inputs).toHaveLength(1);
    expect(state.questions).toEqual([]);
    const confirm = state.agentOptions[0]?.confirm as (req: PermissionRequest) => Promise<ConfirmResult>;
    expect(await confirm(planRequest)).toBe(false);
    expect(err.join("\n")).toContain("read-only session");
  });
});

describe("readOnlyConfirm", () => {
  it("refuses only the plan approval and passes everything else through", async () => {
    const seen: string[] = [];
    const notices: string[] = [];
    const confirm = readOnlyConfirm(
      async (req) => {
        seen.push(req.toolName);
        return { allow: false, feedback: "no" };
      },
      (message) => notices.push(message),
    );
    expect(await confirm(planRequest)).toBe(false);
    expect(await confirm({ toolName: "run_command", permission: "execute", description: "x", command: "ls" })).toEqual({
      allow: false,
      feedback: "no",
    });
    expect(seen).toEqual(["run_command"]);
    expect(notices).toHaveLength(1);
  });
});
