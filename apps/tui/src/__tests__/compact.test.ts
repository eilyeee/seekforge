import { beforeEach, describe, expect, it, vi } from "vitest";

// Both /compact paths hand core the run path's hooks, so preCompact can cancel
// a manual compaction and postCompact hears about it. Core is mocked to see
// exactly what each path passes.
const compactSessionNow = vi.fn();
const llmCompactSessionNow = vi.fn();
const createPromptHookEvaluator = vi.fn((providerFor: (model: string | undefined) => unknown) => ({ providerFor }));

vi.mock("@seekforge/core", () => ({ compactSessionNow, llmCompactSessionNow, createPromptHookEvaluator }));

const { compactOutcomeNotices, compactStoredSession, isCompactionBlocked } = await import("../compact.js");

const hooks = { preCompact: [{ command: "echo pre" }] };

beforeEach(() => {
  compactSessionNow.mockReset();
  llmCompactSessionNow.mockReset();
  createPromptHookEvaluator.mockClear();
});

describe("compactStoredSession", () => {
  it("passes the hooks to the mechanical path, with prompt hooks evaluated by the session's provider", async () => {
    const result = { droppedTurns: 4, beforeTokens: 9_000, afterTokens: 2_000 };
    compactSessionNow.mockResolvedValue(result);
    const provider = vi.fn((model?: string) => ({ model }) as never);
    const onHookError = vi.fn();
    await expect(
      compactStoredSession({ projectPath: "/ws", sessionId: "s1", hooks: hooks as never, provider, onHookError }),
    ).resolves.toBe(result);
    const [workspace, sessionId, lease, options] = compactSessionNow.mock.calls[0]!;
    expect([workspace, sessionId, lease]).toEqual(["/ws", "s1", undefined]);
    expect(options).toMatchObject({ hooks, onError: onHookError });
    // The evaluator asks for the hook's own model, else the session's.
    const { providerFor } = options.evaluate as { providerFor: (model: string | undefined) => unknown };
    providerFor("deepseek-v4-pro");
    providerFor(undefined);
    expect(provider.mock.calls).toEqual([["deepseek-v4-pro"], [undefined]]);
    expect(llmCompactSessionNow).not.toHaveBeenCalled();
  });

  it("passes the hooks and the focus to the LLM path", async () => {
    llmCompactSessionNow.mockResolvedValue(null);
    const provider = vi.fn(() => ({ name: "p" }) as never);
    const onHookError = vi.fn();
    await compactStoredSession({
      projectPath: "/ws",
      sessionId: "s1",
      focus: "the parser",
      hooks: hooks as never,
      provider,
      onHookError,
    });
    expect(llmCompactSessionNow).toHaveBeenCalledWith("/ws", "s1", { name: "p" }, "the parser", {
      hooks,
      onError: onHookError,
    });
    expect(compactSessionNow).not.toHaveBeenCalled();
  });

  it("still goes through the hook-aware path when no hooks are configured", async () => {
    compactSessionNow.mockResolvedValue(null);
    await compactStoredSession({
      projectPath: "/ws",
      sessionId: "s1",
      hooks: undefined,
      provider: () => ({}) as never,
      onHookError: () => {},
    });
    const options = compactSessionNow.mock.calls[0]![3] as Record<string, unknown>;
    expect(options).not.toHaveProperty("hooks");
    expect(options).toHaveProperty("evaluate");
  });
});

describe("compactOutcomeNotices", () => {
  it("reports a blocked compaction with the hook's reason and messages", () => {
    const blocked = { blocked: true as const, reason: "keep [2Jthe history", notices: ["saved a copy"] };
    expect(isCompactionBlocked(blocked)).toBe(true);
    expect(compactOutcomeNotices(blocked, false)).toEqual([
      { text: "hook: saved a copy" },
      { text: "compaction cancelled by a preCompact hook: keep [2Jthe history", tone: "error" },
    ]);
  });

  it("reports the counts and any hook messages", () => {
    const done = { droppedTurns: 4, beforeTokens: 9_000, afterTokens: 2_000, notices: ["archived"] };
    expect(isCompactionBlocked(done)).toBe(false);
    expect(compactOutcomeNotices(done, false)).toEqual([
      { text: "hook: archived" },
      { text: "compacted: dropped 4 earlier messages, 9.0K → 2.0K tokens (applies on the next message)" },
    ]);
    expect(compactOutcomeNotices({ droppedTurns: 1, beforeTokens: 10, afterTokens: 5 }, true)).toEqual([
      { text: "compacted (LLM, focused): dropped 1 earlier messages, 10 → 5 tokens" },
    ]);
  });

  it("says when there was nothing to compact", () => {
    expect(compactOutcomeNotices(null, false)[0]?.text).toBe("nothing to compact — the session is still short");
    expect(compactOutcomeNotices(null, true)[0]?.text).toMatch(/model call failed/);
  });
});
