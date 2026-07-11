import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLoopState, listLoopStates, loadLoopState, removeLoopState, saveLoopState,
} from "../../src/agent/loop-state.js";

describe("loop state persistence", () => {
  let workspace: string;
  beforeEach(() => { workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-state-")); });
  afterEach(() => { rmSync(workspace, { recursive: true, force: true }); });

  it("creates, loads, updates, lists, and removes state", () => {
    const created = createLoopState({
      loopId: "loop-one", task: "fix tests", workspace,
      verifyCommand: "pnpm test", maxIterations: 8, costBudgetUsd: 2,
    });
    expect(loadLoopState(workspace, created.loopId)).toEqual(created);
    const updated = {
      ...created, iterations: 1, costUsd: 0.25, sessionId: "session-1",
      lastVerify: { code: 1, output: "one failure" },
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    saveLoopState(workspace, updated);
    expect(listLoopStates(workspace)).toEqual([updated]);
    expect(removeLoopState(workspace, created.loopId)).toBe(true);
    expect(removeLoopState(workspace, created.loopId)).toBe(false);
  });

  it("writes atomically without leaving temporary files", () => {
    const state = createLoopState({ task: "fix", workspace, verifyCommand: "test", maxIterations: 1 });
    expect(readdirSync(join(workspace, ".seekforge", "loops"))).toEqual([`${state.loopId}.json`]);
  });

  it.each(["../escape", "a/b", ".", "", "loop.json", " space"])(
    "rejects unsafe id %j", (loopId) => {
      expect(() => createLoopState({ loopId, task: "x", workspace, verifyCommand: "test", maxIterations: 1 }))
        .toThrow(/Invalid loop id/);
      expect(() => loadLoopState(workspace, loopId)).toThrow(/Invalid loop id/);
      expect(() => removeLoopState(workspace, loopId)).toThrow(/Invalid loop id/);
    },
  );

  it("rejects relative workspaces", () => {
    expect(() => createLoopState({ task: "x", workspace: "relative", verifyCommand: "test", maxIterations: 1 }))
      .toThrow(/absolute path/);
  });

  it("rejects a symlinked loop directory that escapes the workspace", () => {
    const outside = mkdtempSync(join(tmpdir(), "seekforge-loop-state-outside-"));
    try {
      mkdirSync(join(workspace, ".seekforge"), { recursive: true });
      symlinkSync(outside, join(workspace, ".seekforge", "loops"));
      expect(() => createLoopState({ task: "x", workspace, verifyCommand: "test", maxIterations: 1 }))
        .toThrow(/escapes the workspace/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("returns null for malformed and non-object JSON", () => {
    createLoopState({ loopId: "bad", task: "x", workspace, verifyCommand: "test", maxIterations: 1 });
    const file = join(workspace, ".seekforge", "loops", "bad.json");
    for (const content of ["{", "null", "[]", '"text"']) {
      writeFileSync(file, content);
      expect(loadLoopState(workspace, "bad")).toBeNull();
    }
  });

  it("rejects non-finite and inconsistent numbers", () => {
    const state = createLoopState({
      loopId: "numbers", task: "x", workspace, verifyCommand: "test", maxIterations: 2,
    });
    expect(() => saveLoopState(workspace, { ...state, costUsd: Infinity })).toThrow(/Invalid loop state/);
    expect(() => saveLoopState(workspace, { ...state, iterations: 3 })).toThrow(/Invalid loop state/);
    writeFileSync(
      join(workspace, ".seekforge", "loops", "numbers.json"),
      JSON.stringify({ ...state, costBudgetUsd: "Infinity" }),
    );
    expect(loadLoopState(workspace, "numbers")).toBeNull();
  });

  it("skips corrupt records and rejects records copied across workspaces", () => {
    const state = createLoopState({
      loopId: "valid", task: "x", workspace, verifyCommand: "test", maxIterations: 1,
    });
    writeFileSync(join(workspace, ".seekforge", "loops", "corrupt.json"), "null");
    expect(listLoopStates(workspace)).toEqual([state]);

    const other = mkdtempSync(join(tmpdir(), "seekforge-loop-state-other-"));
    try {
      createLoopState({ loopId: "valid", task: "x", workspace: other, verifyCommand: "test", maxIterations: 1 });
      writeFileSync(join(other, ".seekforge", "loops", "valid.json"), JSON.stringify(state));
      expect(loadLoopState(other, "valid")).toBeNull();
    } finally { rmSync(other, { recursive: true, force: true }); }
  });
});
