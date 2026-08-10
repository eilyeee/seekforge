import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  loadConfig: () => ({ apiKey: "test-key", model: "deepseek-v4-flash" }),
}));

vi.mock("../authorized-dirs.js", () => ({
  authorizeDir: vi.fn(),
  isAuthorizedDir: () => true,
}));

// A scripted agent: it reports a huge cumulative token count at a cost of 0
// (a provider with no price table) and records whether it was allowed to keep
// going afterwards.
const { scripted } = vi.hoisted(() => ({ scripted: { ranPastCeiling: false } }));
vi.mock("../agent-factory.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCliAgent: () => ({
    agent: {
      runTask: async function* (input: { signal?: AbortSignal }) {
        yield { type: "session.created", sessionId: "s-ceiling" };
        yield {
          type: "usage.updated",
          usage: { promptTokens: 5_000_000, completionTokens: 4_000_000, cacheHitTokens: 0, costUsd: 0 },
        };
        if (input.signal?.aborted) return; // ceiling fired → stop
        scripted.ranPastCeiling = true;
        yield {
          type: "session.completed",
          report: {
            summary: "done",
            changedFiles: [],
            commandsRun: [],
            verification: "no commands were run",
            usage: { promptTokens: 5_000_000, completionTokens: 4_000_000, cacheHitTokens: 0, costUsd: 0 },
          },
        };
      },
    },
    dispose: () => {},
  }),
}));

const { runTaskCommand } = await import("../commands/run.js");

describe("runTaskCommand setup lifecycle", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("does not install a SIGINT listener before permission-mode validation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.listeners("SIGINT");

    const completed = await runTaskCommand("task", { mode: "edit", permissionMode: "invalid" });

    expect(completed).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(before);
  });

  it("does not install a SIGINT listener before output-style validation succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = process.listeners("SIGINT");

    const completed = await runTaskCommand("task", { mode: "edit", outputStyle: "missing-style" });

    expect(completed).toBe(false);
    expect(process.listeners("SIGINT")).toEqual(before);
  });
});

describe("runTaskCommand token ceiling", () => {
  afterEach(() => {
    process.exitCode = undefined;
    scripted.ranPastCeiling = false;
    vi.restoreAllMocks();
  });

  it("aborts an unattended run at the ceiling even when cost stays zero", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const completed = await runTaskCommand("task", {
      mode: "ask",
      outputFormat: "json",
      suppressResult: true,
      maxCostUsd: 999, // unreachable without a price table
      maxTotalTokens: 8_000_000,
    });

    expect(scripted.ranPastCeiling).toBe(false);
    expect(completed).toBe(false);
  });

  it("does not bound a run when no ceiling is set", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const completed = await runTaskCommand("task", { mode: "ask", outputFormat: "json", suppressResult: true });

    expect(scripted.ranPastCeiling).toBe(true);
    expect(completed).toBe(true);
  });
});
