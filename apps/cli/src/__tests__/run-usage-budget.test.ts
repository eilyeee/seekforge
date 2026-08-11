/**
 * --max-cost across a session that spans several runs.
 *
 * One `seekforge run` invocation can drive more than one agent run over the
 * SAME session (stream-json turns, plan → execute, --resume). Core reports the
 * run window and the session window on every usage snapshot; the budget has to
 * read the session one, or each new run hands the same budget out again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  loadConfig: () => ({ apiKey: "test-key", model: "deepseek-v4-flash" }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

vi.mock("../stream-input.js", () => ({
  readStreamJsonInput: async function* () {
    yield "first turn";
    yield "second turn";
  },
}));

const usage = (costUsd: number) => ({ promptTokens: 10, completionTokens: 5, cacheHitTokens: 0, costUsd });

const { scripted } = vi.hoisted(() => ({ scripted: { runs: 0, ranPastBudget: false } }));

// Turn 1 spends 0.06 in a fresh session; turn 2 resumes it and spends 0.06
// more. Neither RUN reaches a 0.10 budget on its own; the SESSION does.
vi.mock("../agent-factory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCliAgent: () => ({
    agent: {
      runTask: async function* (input: { signal?: AbortSignal; resumeSessionId?: string }) {
        scripted.runs++;
        const resumed = input.resumeSessionId !== undefined;
        if (!resumed) yield { type: "session.created", sessionId: "s-budget" };
        yield {
          type: "usage.updated",
          usage: usage(0.06),
          sessionUsage: usage(resumed ? 0.12 : 0.06),
        };
        if (input.signal?.aborted) return; // budget fired → stop
        if (resumed) scripted.ranPastBudget = true;
        yield {
          type: "session.completed",
          report: {
            summary: "done",
            changedFiles: [],
            commandsRun: [],
            verification: "no commands were run",
            usage: usage(0.06),
            sessionUsage: usage(resumed ? 0.12 : 0.06),
          },
        };
      },
    },
    dispose: () => {},
  }),
}));

const { runTaskCommand } = await import("../commands/run.js");

describe("runTaskCommand cost budget across a resumed session", () => {
  afterEach(() => {
    process.exitCode = undefined;
    scripted.runs = 0;
    scripted.ranPastBudget = false;
    vi.restoreAllMocks();
  });

  it("stops the second turn on the session total, not that turn's own spend", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const completed = await runTaskCommand("task", {
      mode: "ask",
      outputFormat: "json",
      inputFormat: "stream-json",
      suppressResult: true,
      maxCostUsd: 0.1,
    });

    expect(scripted.runs).toBe(2); // the first turn is under budget and finishes
    expect(scripted.ranPastBudget).toBe(false);
    expect(completed).toBe(false);
  });

  it("lets a session that stays under the budget run every turn", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const completed = await runTaskCommand("task", {
      mode: "ask",
      outputFormat: "json",
      inputFormat: "stream-json",
      suppressResult: true,
      maxCostUsd: 5,
    });

    expect(scripted.runs).toBe(2);
    expect(scripted.ranPastBudget).toBe(true);
    expect(completed).toBe(true);
  });
});
