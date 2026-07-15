import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { resumeAutoLoop, runAutoLoop, type LoopEvent, type LoopOptions } from "../../src/agent/auto-loop.js";
import { loadLoopState } from "../../src/agent/loop-state.js";
import { setSandboxAvailabilityCheckForTests } from "../../src/tools/os-sandbox.js";

const USAGE = { promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd: 0.001 };

const text = (content: string): ChatResponse => ({
  content,
  toolCalls: [],
  usage: USAGE,
  finishReason: "stop",
});

/** Provider that always replies with a terminal text turn (each run = 1 chat). */
function alwaysDone(model: string) {
  const seen: ChatMessage[][] = [];
  const p = {
    model,
    chats: 0,
    seen,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      p.chats++;
      seen.push(req.messages);
      return text("done");
    },
    chatStream(req: ChatRequest): Promise<ChatResponse> {
      return p.chat(req);
    },
  };
  return p;
}

/** A no-op dispatcher (the loop's agent never calls tools in these tests). */
const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async (_c: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
};

function mkDeps(model = "flash"): { deps: AgentCoreDeps; provider: ReturnType<typeof alwaysDone> } {
  const provider = alwaysDone(model);
  const deps: AgentCoreDeps = { provider, dispatcher: noopDispatcher, confirm: async () => true };
  return { deps, provider };
}

/** A verify that fails (code 1) the first `failures` calls, then passes (code 0). */
function failNTimes(failures: number) {
  let n = 0;
  return async (_ws: string, _cmd: string) => {
    const i = n++;
    return i < failures ? { code: 1, output: `fail ${i}` } : { code: 0, output: "ok" };
  };
}

const baseOpts = (workspace: string, verify: LoopOptions["verify"]): LoopOptions => ({
  task: "make it green",
  workspace,
  verifyCommand: "echo test",
  verify,
});

describe("runAutoLoop", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-autoloop-"));
  });
  afterEach(() => {
    setSandboxAvailabilityCheckForTests(null);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("passes after K iterations (verify fails K-1 times incl. pre-check)", async () => {
    const { deps } = mkDeps();
    // pre-check fails(0), iter1 verify fails(1), iter2 verify passes.
    const events: LoopEvent[] = [];
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, failNTimes(2)),
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("passed");
    expect(result.iterations).toBe(2);
    expect(result.finalVerify.code).toBe(0);
    expect(result.sessionId).not.toBe("");
    // Each iteration ran once → 2 runs at 0.001 each.
    expect(result.costUsd).toBeCloseTo(0.002, 6);
    expect(events.some((e) => e.type === "loop.done")).toBe(true);
    expect(events.filter((e) => e.type === "iteration.start")).toHaveLength(2);
  });

  it("writes an append-only JSONL log of the event stream", async () => {
    const { deps } = mkDeps();
    const events: LoopEvent[] = [];
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, failNTimes(2)),
      onEvent: (e) => events.push(e),
    });
    const logPath = join(workspace, ".seekforge", "loops", `${result.loopId}.log`);
    expect(existsSync(logPath)).toBe(true);
    const logged = readFileSync(logPath, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    // One line per emitted event, each timestamped and carrying the event type.
    expect(logged).toHaveLength(events.length);
    expect(logged.every((l) => typeof l.ts === "string" && typeof l.type === "string")).toBe(true);
    expect(logged.map((l) => l.type)).toEqual(events.map((e) => e.type));
    expect(logged.at(-1)?.type).toBe("loop.done");
  });

  it("does not write a log when persistence is disabled", async () => {
    const { deps } = mkDeps();
    const result = await runAutoLoop(deps, { ...baseOpts(workspace, failNTimes(1)), persist: false });
    expect(existsSync(join(workspace, ".seekforge", "loops", `${result.loopId}.log`))).toBe(false);
  });

  it("ignores invalid limits: maxIterations<=0 falls back to default, budget<=0 is no cap", async () => {
    const { deps } = mkDeps();
    // verify fails (pre-check + iter1), passes iter2. maxIterations:0 and
    // budget:0 are invalid — they must NOT short-circuit to exhausted/budget.
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, failNTimes(2)),
      maxIterations: 0,
      costBudgetUsd: 0,
    });
    expect(result.status).toBe("passed");
    expect(result.iterations).toBe(2);
  });

  it("reuses ONE session across iterations (resumeSessionId)", async () => {
    const { deps, provider } = mkDeps();
    const result = await runAutoLoop(deps, baseOpts(workspace, failNTimes(3)));
    expect(result.status).toBe("passed");
    expect(result.iterations).toBe(3);
    // First run gets the task verbatim; later runs reference the verify command.
    const sawTask = provider.seen.some((msgs) =>
      msgs.some((m) => typeof m.content === "string" && m.content.includes("make it green")),
    );
    const sawContinuation = provider.seen.some((msgs) =>
      msgs.some((m) => typeof m.content === "string" && m.content.includes("still fails")),
    );
    expect(sawTask).toBe(true);
    expect(sawContinuation).toBe(true);
  });

  it("passes with 0 iterations when verify is green up front", async () => {
    const { deps, provider } = mkDeps();
    const result = await runAutoLoop(deps, baseOpts(workspace, failNTimes(0)));
    expect(result.status).toBe("passed");
    expect(result.iterations).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.sessionId).toBe("");
    // No run happened.
    expect(provider.chats).toBe(0);
  });

  it("uses the provider selected by LoopOptions.model", async () => {
    const primary = mkDeps("primary");
    const selected = alwaysDone("selected");
    primary.deps.providerForModel = (model) => {
      expect(model).toBe("selected");
      return selected;
    };
    await runAutoLoop(primary.deps, {
      ...baseOpts(workspace, failNTimes(1)),
      model: "selected",
    });
    expect(selected.chats).toBe(1);
    expect(primary.provider.chats).toBe(0);
  });

  it("rejects concurrent runs for the same loop id and releases after completion", async () => {
    const loopId = "exclusive-loop";
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, async () => {
        entered();
        await blocked;
        return { code: 0, output: "green" };
      }),
      loopId,
    });
    await started;
    await expect(runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(0)),
      loopId,
    })).rejects.toThrow("already running");
    unblock();
    await expect(first).resolves.toMatchObject({ status: "passed" });
    await expect(runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(0)),
      loopId,
    })).resolves.toMatchObject({ status: "passed" });
  });

  it("recovers a lease whose owning process is dead", async () => {
    const loopId = "stale-loop";
    const root = join(workspace, ".seekforge", "loops");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `.${loopId}.lock`), JSON.stringify({ pid: 2_147_483_647, token: "old" }));
    await expect(runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(0)),
      loopId,
    })).resolves.toMatchObject({ status: "passed" });
    expect(existsSync(join(root, `.${loopId}.lock`))).toBe(false);
  });

  it("persist:false suppresses every state and lease write", async () => {
    await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(0)),
      loopId: "memory-only",
      persist: false,
    });
    expect(existsSync(join(workspace, ".seekforge"))).toBe(false);
  });

  it("does not mask the loop result when persistence fails and warns once", async () => {
    const loopId = "broken-save";
    const root = join(workspace, ".seekforge", "loops");
    mkdirSync(join(root, `${loopId}.json`), { recursive: true });
    const events: LoopEvent[] = [];
    const result = await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(0)),
      loopId,
      onEvent: (event) => events.push(event),
    });
    expect(result.status).toBe("passed");
    const warnings = events.filter((event) => event.type === "loop.warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ warning: "persistence" });
    expect(warnings[0]?.type === "loop.warning" && warnings[0].message.length).toBeLessThanOrEqual(500);
  });

  it("streams live verification output during the pre-check", async () => {
    const { deps } = mkDeps();
    const events: LoopEvent[] = [];
    await runAutoLoop(deps, {
      ...baseOpts(workspace, async (_ws, _cmd, _signal, onOutput) => {
        onOutput?.("stdout", "testing 1/2\n");
        return { code: 0, output: "ok" };
      }),
      onEvent: (event) => events.push(event),
    });
    expect(events).toContainEqual({
      type: "verify.output",
      iteration: 0,
      stream: "stdout",
      chunk: "testing 1/2\n",
    });
  });

  it("bounds live verification events and chunk size", async () => {
    const { deps } = mkDeps();
    const events: LoopEvent[] = [];
    await runAutoLoop(deps, {
      ...baseOpts(workspace, async (_ws, _cmd, _signal, onOutput) => {
        for (let i = 0; i < 150; i++) onOutput?.("stdout", "x".repeat(20_000));
        return { code: 0, output: "ok" };
      }),
      onEvent: (event) => events.push(event),
    });
    const output = events.filter((event) => event.type === "verify.output");
    expect(output).toHaveLength(100);
    expect(output.every((event) => event.type === "verify.output" && event.chunk.length === 16_384)).toBe(true);
  });

  it("exhausted when verify never passes within maxIterations", async () => {
    const { deps } = mkDeps();
    let n = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: `still failing ${n++}` })),
      maxIterations: 3,
    });
    expect(result.status).toBe("exhausted");
    expect(result.iterations).toBe(3);
    expect(result.finalVerify.code).toBe(1);
  });

  it("stops on budget when costBudgetUsd is exceeded", async () => {
    const { deps } = mkDeps();
    let n = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: `out ${n++}` })),
      maxIterations: 10,
      costBudgetUsd: 0.0015, // exceeded after the 2nd run (0.002 >= 0.0015)
    });
    expect(result.status).toBe("budget");
    expect(result.iterations).toBe(2);
    expect(result.costUsd).toBeGreaterThanOrEqual(0.0015);
  });

  it("stops the active run on the first observed usage that reaches the budget", async () => {
    const { deps } = mkDeps();
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, failNTimes(2)),
      maxIterations: 8,
      costBudgetUsd: 0.0005,
    });
    expect(result.status).toBe("budget");
    expect(result.iterations).toBe(1);
    expect(result.costUsd).toBeCloseTo(0.001, 6);
  });

  it("stops on no_progress when verify output never changes", async () => {
    const { deps } = mkDeps();
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: "identical output" })),
      maxIterations: 8,
    });
    expect(result.status).toBe("no_progress");
    // The first no-op run is compared with the pre-check fingerprint.
    expect(result.iterations).toBe(1);
  });

  it("ignores timing noise when comparing structured verification failures", async () => {
    const { deps } = mkDeps();
    let call = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => ({
        code: 1,
        output: `vitest\n × parser rejects bad input ${++call * 10}ms`,
      })),
      maxIterations: 8,
    });
    expect(result.status).toBe("no_progress");
    expect(result.iterations).toBe(1);
  });

  it("detects same-size edits beyond the first megabyte", async () => {
    const { deps } = mkDeps();
    const target = join(workspace, "large.bin");
    const prefix = "x".repeat(1_100_000);
    writeFileSync(target, `${prefix}a`);
    let checks = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        checks++;
        writeFileSync(target, `${prefix}${String.fromCharCode(97 + checks)}`);
        return checks < 3
          ? { code: 1, output: "identical failure" }
          : { code: 0, output: "green" };
      }),
      maxIterations: 3,
    });
    expect(result.status).toBe("passed");
    expect(result.iterations).toBe(2);
  });

  it("does not follow workspace symlinks when fingerprinting", async () => {
    const { deps } = mkDeps();
    const outside = mkdtempSync(join(tmpdir(), "seekforge-autoloop-outside-"));
    const target = join(outside, "changing.txt");
    writeFileSync(target, "before");
    symlinkSync(target, join(workspace, "outside-link"));
    let checks = 0;
    try {
      const result = await runAutoLoop(deps, {
        ...baseOpts(workspace, async () => {
          writeFileSync(target, `outside-${++checks}`);
          return { code: 1, output: "identical failure" };
        }),
      });
      expect(result.status).toBe("no_progress");
      expect(result.iterations).toBe(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("parses early diagnostics while exposing only the 4KB output tail", async () => {
    const { deps, provider } = mkDeps();
    let checks = 0;
    const early = "Vitest\n× tests/early.test.ts > fails first\nTest Files 1 failed\n";
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        checks++;
        return checks < 3
          ? { code: 1, output: early.replace("fails first", `fails first ${checks}`) + "x".repeat(300_000) }
          : { code: 0, output: "green" };
      }),
    });
    expect(result.status).toBe("passed");
    expect(provider.seen.flat().some((message) =>
      typeof message.content === "string" && message.content.includes("tests/early.test.ts > fails first"),
    )).toBe(true);
    expect(result.finalVerify.output.length).toBeLessThanOrEqual(4096);
  });

  it("keeps streamed verifier output authoritative over a raw captured prefix", async () => {
    const { deps, provider } = mkDeps();
    let checks = 0;
    const streamedFailure = (attempt: number) =>
      `Vitest\n× tests/streamed.test.ts > preserves the tail ${attempt}\nTest Files 1 failed\n`;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async (_ws, _cmd, _signal, onOutput) => {
        checks++;
        if (checks <= 2) {
          onOutput?.("stdout", streamedFailure(checks));
          return { code: 1, output: "raw captured prefix only" };
        }
        return { code: 0, output: "green" };
      }),
    });
    expect(result.status).toBe("passed");
    expect(provider.seen.flat().some((message) =>
      typeof message.content === "string" && message.content.includes("tests/streamed.test.ts > preserves the tail"),
    )).toBe(true);
    expect(provider.seen.flat().some((message) =>
      typeof message.content === "string" && message.content.includes("raw captured prefix only"),
    )).toBe(false);
  });

  it("cancels via an aborted signal", async () => {
    const { deps } = mkDeps();
    const controller = new AbortController();
    let n = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        controller.abort();
        return { code: 1, output: `out ${n++}` };
      }),
      maxIterations: 8,
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(0);
  });

  it("does not run verification when already cancelled", async () => {
    const { deps, provider } = mkDeps();
    const controller = new AbortController();
    controller.abort();
    let verifies = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        verifies++;
        return { code: 0, output: "ok" };
      }),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(0);
    expect(verifies).toBe(0);
    expect(provider.chats).toBe(0);
  });

  it("cancels while verification is running", async () => {
    const { deps } = mkDeps();
    const controller = new AbortController();
    let calls = 0;
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async (_ws, _cmd, signal) => {
        calls++;
        if (calls === 1) return { code: 1, output: "red" };
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          controller.abort();
        });
      }),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.iterations).toBe(1);
  });

  it("surfaces verify_error when the pre-check command can't run", async () => {
    const { deps, provider } = mkDeps();
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        throw new Error("spawn ENOENT");
      }),
    });
    expect(result.status).toBe("verify_error");
    expect(result.iterations).toBe(0);
    expect(provider.chats).toBe(0);
  });

  it("surfaces verifier timeouts as verify_error with captured output", async () => {
    const { deps } = mkDeps();
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => {
        throw new (await import("../../src/tools/errors.js")).ToolError(
          "timeout", "Command timed out after 10ms", { stdout: "partial verifier output" },
        );
      }),
    });
    expect(result).toMatchObject({
      status: "verify_error",
      finalVerify: { code: -1 },
    });
    expect(result.finalVerify.output).toContain("partial verifier output");
    expect(result.finalVerify.output).toContain("timed out");
  });

  it("fails closed when a configured verification sandbox is unavailable", async () => {
    const { deps, provider } = mkDeps();
    deps.sandbox = "workspace-write";
    setSandboxAvailabilityCheckForTests(() => false);
    const result = await runAutoLoop(deps, {
      task: "make it green",
      workspace,
      verifyCommand: "echo ok",
    });
    expect(result.status).toBe("verify_error");
    expect(provider.chats).toBe(0);
  });

  it("persists orchestration state and resumes with prior usage/session", async () => {
    const first = mkDeps();
    const controller = new AbortController();
    let checks = 0;
    const stopped = await runAutoLoop(first.deps, {
      ...baseOpts(workspace, async () => {
        checks++;
        if (checks > 1) controller.abort();
        return { code: 1, output: "still red" };
      }),
      signal: controller.signal,
    });
    expect(stopped.status).toBe("cancelled");
    expect(stopped.loopId).toBeTruthy();
    const saved = loadLoopState(workspace, stopped.loopId!);
    expect(saved?.status).toBe("cancelled");
    expect(saved?.iterations).toBe(1);
    expect(saved?.sessionId).toBe(stopped.sessionId);

    const resumed = await resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      verify: async () => ({ code: 0, output: "green" }),
    });
    expect(resumed.status).toBe("passed");
    expect(resumed.iterations).toBe(1);
    expect(resumed.costUsd).toBe(stopped.costUsd);
    expect(loadLoopState(workspace, stopped.loopId!)?.status).toBe("passed");
  });

  it("resumes an exhausted loop with added iterations and persists the cap", async () => {
    let check = 0;
    const stopped = await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: `red ${check++}` })),
      maxIterations: 1,
    });
    expect(stopped.status).toBe("exhausted");
    const resumed = await resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      additionalIterations: 999,
      verify: failNTimes(1),
    });
    expect(resumed).toMatchObject({ status: "passed", iterations: 2 });
    expect(loadLoopState(workspace, stopped.loopId!)?.maxIterations).toBe(100);
  });

  it("persist:false suppresses writes while resuming persisted state", async () => {
    let check = 0;
    const stopped = await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: `red ${check++}` })),
      maxIterations: 1,
    });
    const before = loadLoopState(workspace, stopped.loopId!);
    const resumed = await resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      persist: false,
      additionalIterations: 1,
      verify: failNTimes(0),
    });
    expect(resumed.status).toBe("passed");
    expect(resumed.loopId).toBeUndefined();
    expect(loadLoopState(workspace, stopped.loopId!)).toEqual(before);
  });

  it("resumes a budget-stopped loop with added USD budget", async () => {
    let check = 0;
    const stopped = await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: `red ${check++}` })),
      maxIterations: 4,
      costBudgetUsd: 0.0005,
    });
    expect(stopped.status).toBe("budget");
    const resumed = await resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      additionalIterations: 1,
      additionalCostBudgetUsd: 0.002,
      verify: failNTimes(1),
    });
    expect(resumed.status).toBe("passed");
    expect(loadLoopState(workspace, stopped.loopId!)?.costBudgetUsd).toBeCloseTo(0.0025, 6);
  });

  it("rejects invalid additive resume limits at the core boundary", async () => {
    const stopped = await runAutoLoop(mkDeps().deps, {
      ...baseOpts(workspace, failNTimes(1)),
      maxIterations: 1,
      costBudgetUsd: Number.MAX_VALUE,
    });
    await expect(resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      additionalIterations: -1,
    })).rejects.toThrow(/positive safe integer/);
    await expect(resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      additionalCostBudgetUsd: Number.POSITIVE_INFINITY,
    })).rejects.toThrow(/finite positive number/);
    await expect(resumeAutoLoop(mkDeps().deps, stopped.loopId!, {
      workspace,
      additionalCostBudgetUsd: Number.MAX_VALUE,
    })).rejects.toThrow(/resulting cost budget must be finite/);
  });
});
