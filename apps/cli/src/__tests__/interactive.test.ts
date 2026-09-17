// Pure pieces of the interactive surface: the TUI/REPL choice, permission
// answers, the REPL's line reader, --debug filtering and `!` output capture.

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, PermissionRequest } from "@seekforge/shared";
import { createLineReader, withUserShellContext } from "../commands/repl.js";
import {
  createDebugLogger,
  debugCategoryEnabled,
  debugCategoryOf,
  describeDebugEvent,
  parseDebugFilter,
} from "../debug-log.js";
import { parsePermissionAnswer, permissionPromptText } from "../permission-answer.js";
import { formatPermissionRequest, formatPlanItems } from "../render.js";
import { runShell, runShellCapture } from "../shell-capture.js";
import { classicReplRequested, decideInteractiveFrontend, launchTui, resolveTuiEntry } from "../tui-launch.js";

// The TUI's own launch parser, loaded at run time: the forwarding below must be
// what it accepts, but the CLI's typecheck should not pull in the TUI's sources.
const tuiCliArgs = new URL("../../../tui/src/cli-args.ts", import.meta.url).href;
const { parseTuiArgs } = (await import(tuiCliArgs)) as {
  parseTuiArgs: (argv: readonly string[]) => Record<string, unknown>;
};

const tty = { env: {}, stdinIsTTY: true, stdoutIsTTY: true, explicitChat: false };

describe("decideInteractiveFrontend", () => {
  it("opens the TUI for bare `seekforge` at a terminal, forwarding what it understands", () => {
    expect(decideInteractiveFrontend({ ...tty, flags: {} })).toEqual({ kind: "tui", args: [] });
    expect(
      decideInteractiveFrontend({
        ...tty,
        flags: { continue: true, model: "deepseek-v4-pro", addDir: [], yes: undefined },
      }),
    ).toEqual({ kind: "tui", args: ["--continue", "--model=deepseek-v4-pro"] });
  });

  it("forwards the session flags the TUI now reads, in the =value form", () => {
    const decision = decideInteractiveFrontend({
      ...tty,
      flags: {
        resume: "s1",
        permissionMode: "plan",
        yes: true,
        dangerouslySkipPermissions: true,
        addDir: ["../x", "-odd"],
        settings: "s.json",
        profile: "work",
        mcpConfig: "m.json",
        strictMcpConfig: true,
        appendSystemPrompt: "-be terse",
        verbose: true,
        model: "m",
      },
    });
    expect(decision).toEqual({
      kind: "tui",
      args: [
        "--resume=s1",
        "--permission-mode=plan",
        "--yes",
        "--add-dir=../x",
        "--add-dir=-odd",
        "--settings=s.json",
        "--profile=work",
        "--mcp-config=m.json",
        "--strict-mcp-config",
        "--append-system-prompt=-be terse",
        "--verbose",
        "--model=m",
      ],
    });
    // What the TUI parser makes of it.
    expect(decision.kind === "tui" ? parseTuiArgs(decision.args) : undefined).toMatchObject({
      resume: "s1",
      permissionMode: "plan",
      yes: true,
      addDirs: ["../x", "-odd"],
      settings: "s.json",
      profile: "work",
      mcpConfig: "m.json",
      strictMcpConfig: true,
      appendSystemPrompt: "-be terse",
      verbose: true,
      model: "m",
    });
  });

  it("lets --resume win over -c and drops an empty appended prompt, as the REPL does", () => {
    expect(
      decideInteractiveFrontend({ ...tty, flags: { continue: true, resume: "s2", appendSystemPrompt: "" } }),
    ).toEqual({ kind: "tui", args: ["--resume=s2"] });
    expect(decideInteractiveFrontend({ ...tty, flags: { dangerouslySkipPermissions: true } })).toEqual({
      kind: "tui",
      args: ["--yes"],
    });
  });

  it("keeps the classic REPL for `chat`, --classic and SEEKFORGE_CLASSIC_REPL", () => {
    expect(decideInteractiveFrontend({ ...tty, explicitChat: true, flags: {} })).toEqual({ kind: "repl" });
    expect(decideInteractiveFrontend({ ...tty, flags: { classic: true } })).toEqual({ kind: "repl" });
    expect(decideInteractiveFrontend({ ...tty, env: { SEEKFORGE_CLASSIC_REPL: "1" }, flags: {} })).toEqual({
      kind: "repl",
    });
  });

  it("keeps the REPL without a terminal on both ends", () => {
    expect(decideInteractiveFrontend({ ...tty, stdinIsTTY: false, flags: {} })).toEqual({ kind: "repl" });
    expect(decideInteractiveFrontend({ ...tty, stdoutIsTTY: false, flags: {} })).toEqual({ kind: "repl" });
  });

  it("falls back to the REPL, naming the flags, when the TUI would drop them", () => {
    expect(
      decideInteractiveFrontend({
        ...tty,
        flags: { resume: "s1", yes: true, ask: true, sessionId: "x", maxCost: 1, outputStyle: "concise", model: "m" },
      }),
    ).toEqual({ kind: "repl", unsupported: ["--ask", "--max-cost", "--output-style", "--session-id"] });
    expect(
      decideInteractiveFrontend({
        ...tty,
        flags: { systemPrompt: "x", appendSystemPromptFile: "f", agents: "{}", debug: true, allowedTools: "a" },
      }),
    ).toEqual({
      kind: "repl",
      unsupported: ["--agents", "--allowedTools", "--append-system-prompt-file", "--debug", "--system-prompt"],
    });
  });

  it("leaves a SEEKFORGE_PROFILE in the environment to the TUI, which reads it itself", () => {
    expect(decideInteractiveFrontend({ ...tty, env: { SEEKFORGE_PROFILE: "work" }, flags: {} })).toEqual({
      kind: "tui",
      args: [],
    });
  });

  it("reads SEEKFORGE_CLASSIC_REPL's falsy spellings as off", () => {
    for (const value of ["", "0", "false", "no", " FALSE "]) {
      expect(classicReplRequested({ SEEKFORGE_CLASSIC_REPL: value })).toBe(false);
    }
    for (const value of ["1", "true", "yes"])
      expect(classicReplRequested({ SEEKFORGE_CLASSIC_REPL: value })).toBe(true);
  });
});

describe("resolveTuiEntry / launchTui", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("prefers the bundle beside the module, then the workspace source", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-tui-entry-"));
    dirs.push(dir);
    const moduleUrl = pathToFileURL(join(dir, "index.js")).href;
    expect(resolveTuiEntry(moduleUrl)).toBeUndefined();
    writeFileSync(join(dir, "tui.js"), "");
    expect(resolveTuiEntry(moduleUrl)).toBe(join(dir, "tui.js"));
    // From this source file, the checkout's TUI source is found.
    expect(resolveTuiEntry(pathToFileURL(fileURLToPath(new URL("../tui-launch.ts", import.meta.url))).href)).toMatch(
      /apps[\\/]tui[\\/]src[\\/]index\.tsx$/,
    );
  });

  it("starts the entry with argv shaped like `seekforge-tui <args>`", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-tui-launch-"));
    dirs.push(dir);
    const entry = join(dir, "entry.mjs");
    writeFileSync(entry, "globalThis.__tuiArgv = process.argv.slice(1);\n");
    const saved = process.argv;
    try {
      await launchTui(entry, ["--continue", "--model", "m"]);
      expect((globalThis as { __tuiArgv?: string[] }).__tuiArgv).toEqual([entry, "--continue", "--model", "m"]);
    } finally {
      process.argv = saved;
    }
  });
});

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  toolName: "run_command",
  permission: "execute",
  description: "run",
  command: "pnpm test",
  ...over,
});

describe("parsePermissionAnswer", () => {
  it("allows once, or for the session when grantable", () => {
    expect(parsePermissionAnswer("y", { sessionGrantable: true })).toBe(true);
    expect(parsePermissionAnswer(" YES ", { sessionGrantable: true })).toBe(true);
    expect(parsePermissionAnswer("a", { sessionGrantable: true })).toEqual({ allow: true, remember: "session" });
    expect(parsePermissionAnswer("always", { sessionGrantable: true })).toEqual({ allow: true, remember: "session" });
  });

  it("never turns 'always' into a session grant the request cannot carry", () => {
    expect(parsePermissionAnswer("a", { sessionGrantable: false })).toBe(true);
  });

  it("denies with the user's reason", () => {
    expect(parsePermissionAnswer("n: use pnpm instead", { sessionGrantable: true })).toEqual({
      allow: false,
      feedback: "use pnpm instead",
    });
    expect(parsePermissionAnswer("no  wrong directory", { sessionGrantable: true })).toEqual({
      allow: false,
      feedback: "wrong directory",
    });
    expect(parsePermissionAnswer("n：换个名字", { sessionGrantable: true })).toEqual({
      allow: false,
      feedback: "换个名字",
    });
    const long = parsePermissionAnswer(`n: ${"x".repeat(5000)}`, { sessionGrantable: true });
    expect(typeof long === "object" && !long.allow && long.feedback?.length).toBe(2000);
  });

  it("denies anything else, including an empty answer", () => {
    for (const answer of ["", "n", "no", "N", "n:", "nope", "note: fine", "sure", "yes please"]) {
      expect(parsePermissionAnswer(answer, { sessionGrantable: true })).toBe(false);
    }
  });

  it("offers the session option only when the request allows it", () => {
    expect(permissionPromptText(request())).toContain("[a]");
    expect(permissionPromptText(request({ sessionGrantable: false }))).not.toContain("[a]");
  });
});

describe("confirmInTerminal", () => {
  afterEach(() => {
    vi.doUnmock("node:readline/promises");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function answer(text: string, req: PermissionRequest) {
    vi.resetModules();
    const questions: string[] = [];
    vi.doMock("node:readline/promises", () => ({
      createInterface: () => ({
        question: async (q: string) => {
          questions.push(q);
          return text;
        },
        once: () => {},
        close: () => {},
      }),
    }));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { confirmInTerminal } = await import("../render.js");
    return { result: await confirmInTerminal(req), questions };
  }

  it("returns the refusal reason and hides the session option for ask-rule prompts", async () => {
    const { result, questions } = await answer("n: not on main", request({ sessionGrantable: false }));
    expect(result).toEqual({ allow: false, feedback: "not on main" });
    expect(questions[0]).not.toContain("[a]");
  });

  it("grants the session when asked on a grantable request", async () => {
    const { result, questions } = await answer("a", request());
    expect(result).toEqual({ allow: true, remember: "session" });
    expect(questions[0]).toContain("[a]");
  });

  it("carries a refusal reason from the per-hunk prompt too", async () => {
    const hunks = [
      { index: 0, preview: "a" },
      { index: 1, preview: "b" },
    ];
    expect((await answer("n: keep b", request({ hunks }))).result).toEqual({ allow: false, feedback: "keep b" });
    expect((await answer("1", request({ hunks }))).result).toEqual({ allow: true, selectedHunks: [1] });
    expect((await answer("a", request({ hunks }))).result).toBe(false);
  });
});

describe("createLineReader", () => {
  function fakeRl(answers: string[]) {
    const emitter = new EventEmitter();
    const asked: string[] = [];
    const rl = Object.assign(emitter, {
      question: async (prompt: string) => {
        asked.push(prompt);
        const next = answers.shift();
        if (next === undefined) throw new Error("closed");
        return next;
      },
    });
    return { rl: rl as unknown as Interface, emitter, asked };
  }

  it("keeps piped lines that arrive between questions", async () => {
    const { rl, emitter, asked } = fakeRl(["asked"]);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const read = createLineReader(rl, true);
      emitter.emit("line", "one");
      emitter.emit("line", "two");
      expect(await read("> ")).toBe("one");
      expect(await read("> ")).toBe("two");
      expect(await read("> ")).toBe("asked");
      expect(asked).toEqual(["> "]);
      await expect(read("> ")).rejects.toThrow("closed");
    } finally {
      write.mockRestore();
    }
  });

  it("never answers a prompt with text typed before it at a terminal", async () => {
    const { rl, emitter } = fakeRl(["typed after"]);
    const read = createLineReader(rl, false);
    emitter.emit("line", "y");
    expect(await read("Allow? ")).toBe("typed after");
  });

  it("honors a cancelled run even for a queued line", async () => {
    const { rl, emitter } = fakeRl([]);
    const read = createLineReader(rl, true);
    emitter.emit("line", "y");
    const controller = new AbortController();
    controller.abort();
    await expect(read("Allow? ", { signal: controller.signal })).rejects.toThrow();
  });
});

describe("withUserShellContext", () => {
  it("leaves the message alone without `!` runs and appends them otherwise", () => {
    expect(withUserShellContext("fix it", [])).toBe("fix it");
    const task = withUserShellContext("fix it", [{ command: "ls", output: "a.ts", exitCode: 0 }]);
    expect(task.startsWith("fix it\n\n<user-shell-commands>")).toBe(true);
    expect(task).toContain('<command exit_code="0">ls</command>');
  });
});

describe("--debug", () => {
  it("parses filters", () => {
    expect(parseDebugFilter(undefined)).toBeNull();
    expect(parseDebugFilter(false)).toBeNull();
    const all = parseDebugFilter(true);
    expect(debugCategoryEnabled(all, "api")).toBe(true);
    const some = parseDebugFilter("api, Tool");
    expect(debugCategoryEnabled(some, "tool")).toBe(true);
    expect(debugCategoryEnabled(some, "mcp")).toBe(false);
    const except = parseDebugFilter("!command");
    expect(debugCategoryEnabled(except, "command")).toBe(false);
    expect(debugCategoryEnabled(except, "tool")).toBe(true);
    expect(debugCategoryEnabled(parseDebugFilter(""), "hooks")).toBe(true);
  });

  it("categorizes and describes agent events", () => {
    const retry: AgentEvent = {
      type: "provider.retry",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      reason: "rate limited",
    };
    expect(debugCategoryOf(retry)).toBe("api");
    expect(describeDebugEvent(retry)).toBe(
      'provider.retry {"attempt":1,"maxAttempts":3,"delayMs":500,"reason":"rate limited"}',
    );
    expect(debugCategoryOf({ type: "notice", level: "info", message: "hook said hi" })).toBe("hooks");
    expect(debugCategoryOf({ type: "session.created", sessionId: "s" })).toBe("session");
    expect(debugCategoryOf({ type: "command.output", stream: "stdout", chunk: "x" })).toBe("command");
    expect(describeDebugEvent({ type: "model.message", content: "y".repeat(2000) }).length).toBeLessThanOrEqual(600);
  });

  it("writes only enabled categories, to its sink", () => {
    const lines: string[] = [];
    const logger = createDebugLogger(
      "tool",
      (line) => lines.push(line),
      () => new Date(0),
    );
    logger.event({ type: "tool.started", toolName: "read_file", args: { path: "a" } });
    logger.event({ type: "session.created", sessionId: "s" });
    logger.log("mcp", "ignored");
    expect(lines).toEqual([
      '[debug 1970-01-01T00:00:00.000Z tool] tool.started {"toolName":"read_file","args":{"path":"a"}}\n',
    ]);
    const off = createDebugLogger(undefined, (line) => lines.push(line));
    off.log("tool", "x");
    expect(off.enabled("tool")).toBe(false);
    expect(lines).toHaveLength(1);
  });
});

describe("runShell", () => {
  it("streams output live and keeps only the tail in tail mode", async () => {
    const chunks: string[] = [];
    const result = await runShell("printf 'aaaaa'; printf 'bbbbb'; printf 'ccccc'", process.cwd(), {
      maxBytes: 7,
      overflow: "tail",
      onOutput: (chunk) => chunks.push(chunk),
    });
    expect(chunks.join("")).toBe("aaaaabbbbbccccc");
    expect(result).toMatchObject({ output: "bbccccc", exitCode: 0 });
    expect(result.failure).toBeUndefined();
  });

  it("reports the exit code and a cancellation", async () => {
    expect(await runShell("exit 3", process.cwd())).toMatchObject({ exitCode: 3 });
    const controller = new AbortController();
    const pending = runShell("sleep 5", process.cwd(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    expect(await pending).toMatchObject({ failure: "cancelled" });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("keeps runShellCapture's contract", async () => {
    expect(await runShellCapture("echo hi", process.cwd())).toBe("hi\n");
    expect(await runShellCapture("echo oops; exit 2", process.cwd())).toBe("[command failed: exit 2: oops\n]");
    expect(await runShellCapture("sleep 5", process.cwd(), 50)).toBe("[command failed: timed out after 50ms]");
  });
});

describe("terminal prompt formatting", () => {
  it("prints a plan approval as one indented block, raw", () => {
    const plan = "Leave plan mode and implement this plan:\n\n1. edit a.ts\n   - keep the API\n2. run tests";
    expect(
      formatPermissionRequest(
        { toolName: "exit_plan_mode", permission: "write", description: plan, sessionGrantable: false },
        "Permission required",
      ),
    ).toEqual([
      "\nPermission required [write] exit_plan_mode",
      "  Leave plan mode and implement this plan:",
      "",
      "  1. edit a.ts",
      "     - keep the API",
      "  2. run tests",
    ]);
    // The answer line for it still offers a refusal with a reason.
    expect(
      permissionPromptText({
        toolName: "exit_plan_mode",
        permission: "write",
        description: plan,
        sessionGrantable: false,
      }),
    ).toContain("n: <reason>");
    expect(parsePermissionAnswer("n: split step 2", { sessionGrantable: false })).toEqual({
      allow: false,
      feedback: "split step 2",
    });
  });

  it("shows the raw command or path instead of the description", () => {
    expect(formatPermissionRequest(request({ path: "src/a.ts" }), "P")).toEqual([
      "\nP [execute] run_command",
      "  command: pnpm test",
      "  path:    src/a.ts",
    ]);
  });

  it("shows a step in progress by its activeForm", () => {
    expect(
      formatPlanItems([
        { step: "Write the parser", status: "done", activeForm: "Writing the parser" },
        { step: "Run the tests", status: "in_progress", activeForm: "Running the tests" },
        { step: "Fix lint", status: "in_progress" },
        { step: "Ship", status: "pending", activeForm: "Shipping" },
      ]),
    ).toEqual(["  ☑ Write the parser", "  ◐ Running the tests", "  ◐ Fix lint", "  ☐ Ship"]);
  });
});
