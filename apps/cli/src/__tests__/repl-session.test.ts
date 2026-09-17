/**
 * The classic REPL end to end over a scripted terminal: what reaches each
 * agent build (one session-scoped subagent manager, the --add-dir grant, the
 * reasoning effort), manual compaction with hooks, custom commands that may
 * not take a built-in's name, and the plan flow.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfirmResult, PermissionRequest } from "@seekforge/shared";
import type { UserCommand } from "@seekforge/core";

type Manager = { sessionScoped: boolean; disposeAll: () => void };

const { state } = vi.hoisted(() => ({
  state: {
    config: {} as Record<string, unknown>,
    lines: [] as string[],
    prompts: [] as string[],
    agents: [] as Array<Record<string, unknown>>,
    inputs: [] as Array<Record<string, unknown>>,
    commands: [] as UserCommand[],
    managers: [] as Array<{ manager: Manager; disposed: number }>,
    compactCalls: [] as unknown[][],
    llmCompactCalls: [] as unknown[][],
    compactResult: null as unknown,
    llmCompactResult: null as unknown,
    sessionMode: undefined as "ask" | "edit" | undefined,
    onRun: undefined as undefined | ((opts: Record<string, unknown>) => Promise<void>),
  },
}));

vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    question: async (prompt: string) => {
      state.prompts.push(prompt);
      const next = state.lines.shift();
      if (next === undefined) throw new Error("closed");
      return next;
    },
    close: () => {},
    on: () => {},
    once: () => {},
    removeListener: () => {},
  }),
}));

vi.mock("../config.js", () => ({
  loadConfig: () => state.config,
  resolveConfig: () => ({ config: state.config, mcpOrigins: {} }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@seekforge/core")>();
  return {
    ...real,
    loadUserCommands: () => state.commands,
    createDispatchManager: (options?: { sessionScoped?: boolean }) => {
      const manager = real.createDispatchManager(options);
      const record = { manager: manager as Manager, disposed: 0 };
      const dispose = manager.disposeAll.bind(manager);
      manager.disposeAll = () => {
        record.disposed++;
        dispose();
      };
      state.managers.push(record);
      return manager;
    },
    compactSessionNow: (...args: unknown[]) => {
      state.compactCalls.push(args);
      return Promise.resolve(state.compactResult);
    },
    llmCompactSessionNow: async (...args: unknown[]) => {
      state.llmCompactCalls.push(args);
      return state.llmCompactResult;
    },
    readSessionMeta: (_workspace: string, id: string) =>
      state.sessionMode
        ? { id, task: "t", mode: state.sessionMode, status: "completed", createdAt: "x", updatedAt: "x" }
        : undefined,
  };
});

vi.mock("../agent-factory.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../agent-factory.js")>();
  const core = await import("@seekforge/core");
  return {
    ...real,
    prepareMcp: async (_config: unknown, workspace: string) => ({
      specs: [],
      dispose: () => {},
      pluginContributions: core.loadPluginContributions(workspace),
    }),
    createCliAgent: (opts: Record<string, unknown>) => {
      state.agents.push(opts);
      return {
        agent: {
          runTask: async function* (input: Record<string, unknown>) {
            state.inputs.push(input);
            await state.onRun?.(opts);
            yield { type: "session.created", sessionId: (input.resumeSessionId as string | undefined) ?? "s1" };
            yield {
              type: "session.completed",
              report: {
                summary: "ok",
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
  };
});

const { replCommand, partitionUserCommands, applyThinkArgument, createDeferredDisposer, REPL_BUILTIN_COMMANDS } =
  await import("../commands/repl.js");

let cwd: string;
let home: string;
let out: string[];
const previousHome = process.env["SEEKFORGE_HOME"];

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-repl-"));
  home = mkdtempSync(join(tmpdir(), "sf-repl-home-"));
  process.env["SEEKFORGE_HOME"] = home;
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  out = [];
  const capture = (...args: unknown[]) => {
    out.push(args.join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  state.config = { apiKey: "k", model: "deepseek-v4-flash" };
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env["SEEKFORGE_HOME"];
  else process.env["SEEKFORGE_HOME"] = previousHome;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  Object.assign(state, {
    lines: [],
    prompts: [],
    agents: [],
    inputs: [],
    commands: [],
    managers: [],
    compactCalls: [],
    llmCompactCalls: [],
    compactResult: null,
    llmCompactResult: null,
    sessionMode: undefined,
    onRun: undefined,
  });
});

const command = (name: string, body: string): UserCommand => ({ name, description: name, scope: "project", body });

describe("REPL agent builds", () => {
  it("share one session-scoped subagent manager until /new, and dispose it on exit", async () => {
    state.lines = ["first", "second", "/new", "third"];
    await replCommand({});
    expect(state.agents).toHaveLength(3);
    const [a, b, c] = state.agents.map((opts) => opts.dispatchManager as Manager);
    expect(a?.sessionScoped).toBe(true);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(c?.sessionScoped).toBe(true);
    // The first session's manager ended at /new, the second at exit.
    expect(state.managers.map((record) => record.disposed)).toEqual([1, 1]);
  });

  it("passes --add-dir to the file tools and expands @-references there", async () => {
    const outside = mkdtempSync(join(tmpdir(), "sf-repl-extra-"));
    try {
      state.lines = ["look"];
      await replCommand({ addDirs: [outside, join(cwd, "missing")] });
      expect(state.agents[0]?.additionalDirectories).toEqual([realpathSync(outside)]);
      expect(out.join("\n")).toContain("--add-dir");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("applies /think levels to the next run", async () => {
    state.lines = ["/think low", "go", "/think medium", "/think bogus", "go", "/think off", "go"];
    await replCommand({});
    const configs = state.agents.map((opts) => opts.config as Record<string, unknown>);
    expect(configs[0]).toMatchObject({ thinking: true, reasoningEffort: "low" });
    expect(configs[1]).toMatchObject({ thinking: true, reasoningEffort: "medium" });
    expect(configs[2]).toMatchObject({ thinking: false });
    expect(configs[2]).not.toHaveProperty("reasoningEffort");
    expect(out.join("\n")).toContain("usage: /think [on|off|low|medium|high|max]");
  });

  it("refuses a plan approval in an --ask session", async () => {
    let answer: ConfirmResult | undefined;
    state.onRun = async (opts) => {
      const confirm = opts.confirm as (req: PermissionRequest) => Promise<ConfirmResult>;
      answer = await confirm({ toolName: "exit_plan_mode", permission: "write", description: "plan" });
    };
    state.lines = ["/plan refactor"];
    await replCommand({ ask: true });
    expect(answer).toBe(false);
    expect(state.inputs).toHaveLength(1);
  });
});

describe("REPL /plan", () => {
  it("does not ask to execute a plan the run already approved", async () => {
    state.sessionMode = "edit";
    state.lines = ["/plan refactor", "after"];
    await replCommand({});
    expect(state.prompts.some((prompt) => prompt.includes("Execute this plan?"))).toBe(false);
    // "after" was read as the next message, not as the answer.
    expect(state.inputs.map((input) => input.task)).toEqual(["refactor", "after"]);
  });

  it("asks when the plan run ended in plan mode", async () => {
    state.sessionMode = "ask";
    state.lines = ["/plan refactor", "y"];
    await replCommand({});
    expect(state.prompts.some((prompt) => prompt.includes("Execute this plan?"))).toBe(true);
    expect(state.inputs.map((input) => input.mode)).toEqual(["ask", "edit"]);
  });
});

describe("REPL /compact", () => {
  it("runs the compaction hooks and reports a hook's cancellation", async () => {
    state.config = { ...state.config, hooks: { preCompact: [{ command: "./gate.sh" }] } };
    state.compactResult = { blocked: true, reason: "not now", notices: ["gate says wait"] };
    state.lines = ["work", "/compact"];
    await replCommand({});
    const [workspace, sessionId, lease, options] = state.compactCalls[0] ?? [];
    expect([workspace, sessionId, lease]).toEqual([cwd, "s1", undefined]);
    expect(options).toMatchObject({ hooks: { preCompact: [{ command: "./gate.sh" }] } });
    expect((options as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    expect(typeof (options as { evaluate?: unknown }).evaluate).toBe("function");
    const text = out.join("\n");
    expect(text).toContain("gate says wait");
    expect(text).toContain("compaction cancelled by a preCompact hook: not now");
    expect(text).not.toContain("compacted:");
  });

  it("passes the hooks to a focused compaction and prints its notices", async () => {
    state.llmCompactResult = { droppedTurns: 3, beforeTokens: 900, afterTokens: 300, notices: ["post hook ran"] };
    state.lines = ["work", "/compact the API"];
    await replCommand({});
    const call = state.llmCompactCalls[0] ?? [];
    expect(call[1]).toBe("s1");
    expect(call[3]).toBe("the API");
    expect(call[4]).toMatchObject({ signal: expect.any(AbortSignal) });
    const text = out.join("\n");
    expect(text).toContain("post hook ran");
    expect(text).toContain("compacted (model summary): dropped 3 turn(s), 900 → 300 tokens");
    expect(state.compactCalls).toEqual([]);
  });
});

describe("REPL custom commands", () => {
  it("never lets a command file take a built-in's name, and says so once", async () => {
    state.commands = [
      command("plan", "PWNED plan"),
      command("Help", "PWNED help"),
      command("deploy", "Deploy to $ARGUMENTS"),
    ];
    state.lines = ["/plan real task", "n", "/deploy prod"];
    await replCommand({});
    expect(state.inputs.map((input) => input.task)).toEqual(["real task", "Deploy to prod"]);
    expect(state.inputs[0]).toMatchObject({ plan: true });
    const notices = out.filter((line) => line.includes("ignoring custom command"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("/plan, /Help");
  });
});

describe("REPL helpers", () => {
  it("partitionUserCommands matches built-in names without regard to case", () => {
    const { usable, shadowed } = partitionUserCommands([
      command("EXIT", "x"),
      command("git:commit", "x"),
      command("contextual", "x"),
    ]);
    expect(shadowed).toEqual(["EXIT"]);
    expect(usable.map((c) => c.name)).toEqual(["git:commit", "contextual"]);
  });

  it("names every command the REPL's switch handles as a built-in", () => {
    const source = readFileSync(new URL("../commands/repl.ts", import.meta.url), "utf8");
    const cases = [...source.matchAll(/case "\/([a-z-]+)":/g)].map((match) => match[1]);
    expect(cases.length).toBeGreaterThan(10);
    expect([...new Set(cases)].sort()).toEqual([...REPL_BUILTIN_COMMANDS].sort());
  });

  it("applyThinkArgument leaves the config alone on an unknown argument", () => {
    const config: Record<string, unknown> = { thinking: false };
    expect(applyThinkArgument(config, "ultra")).toBe(false);
    expect(config).toEqual({ thinking: false });
    expect(applyThinkArgument(config, "max")).toBe(true);
    expect(config).toEqual({ thinking: true, reasoningEffort: "max" });
  });

  it("createDeferredDisposer holds teardowns while a dispatch runs", () => {
    let running = true;
    const disposed: string[] = [];
    const teardown = createDeferredDisposer(() => running);
    teardown.add(() => disposed.push("a"));
    teardown.add(() => disposed.push("b"));
    expect(disposed).toEqual([]);
    running = false;
    teardown.add(() => disposed.push("c"));
    expect(disposed).toEqual(["a", "b", "c"]);
    running = true;
    teardown.add(() => {
      throw new Error("boom");
    });
    teardown.add(() => disposed.push("d"));
    teardown.flush(true);
    expect(disposed).toEqual(["a", "b", "c", "d"]);
  });
});
