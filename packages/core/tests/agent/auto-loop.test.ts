import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { ChatRequest } from "../../src/provider/index.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import { runAutoLoop, type LoopEvent, type LoopOptions } from "../../src/agent/auto-loop.js";

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

  it("stops on no_progress when verify output never changes", async () => {
    const { deps } = mkDeps();
    const result = await runAutoLoop(deps, {
      ...baseOpts(workspace, async () => ({ code: 1, output: "identical output" })),
      maxIterations: 8,
    });
    expect(result.status).toBe("no_progress");
    // iter1 records output; iter2 sees identical output → stop.
    expect(result.iterations).toBe(2);
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
});
