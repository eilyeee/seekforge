import { beforeEach, describe, expect, it, vi } from "vitest";

const runAutoLoop = vi.fn();
const dispose = vi.fn();

vi.mock("@seekforge/core", () => ({
  loadAgentDefinitions: vi.fn(() => []),
  runAutoLoop,
}));

vi.mock("../agent/factory.js", () => ({
  buildTuiDeps: vi.fn(() => ({ deps: { marker: "agent-deps" }, dispose })),
}));

vi.mock("@seekforge/shared/file-refs", () => ({
  expandFileRefs: vi.fn((task: string) => task),
}));

const { runLoop } = await import("../agent/run-loop.js");

const result = {
  status: "passed" as const,
  iterations: 1,
  costUsd: 0.1,
  sessionId: "session-1",
  finalVerify: { code: 0, output: "ok" },
};

describe("runLoop", () => {
  beforeEach(() => {
    runAutoLoop.mockReset();
    runAutoLoop.mockResolvedValue(result);
    dispose.mockReset();
  });

  it("inherits config.costBudgetUsd when no command override is supplied", async () => {
    const signal = new AbortController().signal;
    const onEvent = vi.fn();

    await runLoop("fix it", "pnpm test", signal, {
      config: { costBudgetUsd: 2.5 },
      model: "test-model",
      projectPath: "/workspace",
      mcpToolSpecs: [],
      maxIterations: 8,
      onEvent,
    });

    expect(runAutoLoop).toHaveBeenCalledWith(
      { marker: "agent-deps" },
      expect.objectContaining({ maxIterations: 8, costBudgetUsd: 2.5, signal, onEvent }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("uses an explicit command budget instead of the config default", async () => {
    await runLoop("fix it", "pnpm test", new AbortController().signal, {
      config: { costBudgetUsd: 2.5 },
      model: "test-model",
      projectPath: "/workspace",
      mcpToolSpecs: [],
      maxIterations: 12,
      costBudgetUsd: 0.75,
      onEvent: vi.fn(),
    });

    expect(runAutoLoop).toHaveBeenCalledWith(
      { marker: "agent-deps" },
      expect.objectContaining({ maxIterations: 12, costBudgetUsd: 0.75 }),
    );
  });
});
