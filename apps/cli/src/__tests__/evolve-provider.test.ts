// `seekforge evolve analyze` builds its provider the way a run does (core
// buildProvider), so an apiKeyHelper key stays refreshable and telemetry sees
// the request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { state } = vi.hoisted(() => ({
  state: { built: [] as unknown[][], reflectedWith: [] as unknown[] },
}));

vi.mock("../config.js", () => ({
  loadConfig: () => ({
    apiKey: "k",
    provider: "openai",
    model: "gpt-5.5",
    baseUrl: "https://proxy.example/v1",
    reasoningEffort: "low",
    thinking: true,
  }),
}));

vi.mock("@seekforge/core", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    buildProvider: (...args: unknown[]) => {
      state.built.push(args);
      return { model: "built" };
    },
    createDeepSeekProvider: () => {
      throw new Error("evolve must not construct a provider by hand");
    },
    scoreSession: () => ({
      score: 1,
      notes: [],
      metrics: {
        status: "completed",
        turns: 1,
        toolCalls: 0,
        failedToolCalls: 0,
        retriedCommands: 0,
        costUsd: 0,
        verificationRan: false,
      },
    }),
    reflectOnSession: async (provider: unknown) => {
      state.reflectedWith.push(provider);
      return { proposals: [] };
    },
  };
});

const { evolveAnalyzeCommand } = await import("../commands/evolve.js");

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "sf-evolve-"));
  vi.spyOn(process, "cwd").mockReturnValue(cwd);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(cwd, { recursive: true, force: true });
});

it("reflects with a provider from core's buildProvider", async () => {
  await evolveAnalyzeCommand("some-session");
  expect(process.exitCode).toBeUndefined();
  expect(state.built).toEqual([
    [
      expect.objectContaining({
        provider: "openai",
        apiKey: "k",
        baseUrl: "https://proxy.example/v1",
        reasoningEffort: "low",
        thinking: true,
      }),
      "gpt-5.5",
    ],
  ]);
  expect(state.reflectedWith).toEqual([{ model: "built" }]);
});
