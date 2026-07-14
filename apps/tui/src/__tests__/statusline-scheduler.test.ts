import { describe, expect, it } from "vitest";
import {
  initialSchedulerState,
  inputKey,
  shouldRecompute,
  tick,
  type SchedulerState,
} from "../statusline-scheduler.js";
import type { StatusLineInput } from "../statusline.js";

const base: StatusLineInput = { model: "deepseek-chat", cwd: "/tmp", costUsd: 0.1 };

describe("inputKey", () => {
  it("is stable for equal inputs and distinct for changed fields", () => {
    expect(inputKey("cmd", base)).toBe(inputKey("cmd", { ...base }));
    expect(inputKey("cmd", base)).not.toBe(inputKey("other", base));
    expect(inputKey("cmd", base)).not.toBe(inputKey("cmd", { ...base, costUsd: 0.2 }));
    expect(inputKey("cmd", base)).not.toBe(inputKey("cmd", { ...base, approval: "auto" }));
  });
});

describe("shouldRecompute", () => {
  it("always recomputes the very first time", () => {
    expect(shouldRecompute(initialSchedulerState, "cmd", base, 0, 1000)).toBe(true);
  });

  it("requires both a changed input and elapsed interval", () => {
    const state: SchedulerState = { lastOutput: "x", lastInputKey: inputKey("cmd", base), lastComputedAt: 1000 };
    // Same input → never recompute, even far in the future.
    expect(shouldRecompute(state, "cmd", base, 99999, 1000)).toBe(false);
    // Changed input but within the interval → wait.
    expect(shouldRecompute(state, "cmd", { ...base, costUsd: 0.2 }, 1500, 1000)).toBe(false);
    // Changed input and interval elapsed → recompute.
    expect(shouldRecompute(state, "cmd", { ...base, costUsd: 0.2 }, 2000, 1000)).toBe(true);
    expect(shouldRecompute(state, "other", base, 2000, 1000)).toBe(true);
  });
});

describe("tick", () => {
  it("runs and caches output on the first tick", () => {
    const r = tick(initialSchedulerState, "cmd", base, { now: 0, run: () => "line one" });
    expect(r.recomputed).toBe(true);
    expect(r.state.lastOutput).toBe("line one");
    expect(r.state.lastComputedAt).toBe(0);
  });

  it("does not run again when nothing changed", () => {
    let calls = 0;
    const run = (): string => {
      calls += 1;
      return "out";
    };
    let r = tick(initialSchedulerState, "cmd", base, { now: 0, run });
    r = tick(r.state, "cmd", base, { now: 10000, run });
    expect(r.recomputed).toBe(false);
    expect(calls).toBe(1);
  });

  it("recomputes when the command changes and the input does not", () => {
    const commands: string[] = [];
    const run = (command: string): string => {
      commands.push(command);
      return command;
    };
    let result = tick(initialSchedulerState, "first", base, { now: 0, run });
    result = tick(result.state, "second", base, { now: 2000, run });
    expect(result.recomputed).toBe(true);
    expect(result.state.lastOutput).toBe("second");
    expect(commands).toEqual(["first", "second"]);
  });

  it("keeps the previous cached output when a recompute fails", () => {
    let r = tick(initialSchedulerState, "cmd", base, { now: 0, run: () => "good" });
    r = tick(r.state, "cmd", { ...base, costUsd: 0.5 }, { now: 5000, run: () => null });
    expect(r.recomputed).toBe(true);
    expect(r.state.lastOutput).toBe("good");
  });

  it("recomputes once input changes and the interval has elapsed", () => {
    const outputs = ["a", "b"];
    let i = 0;
    const run = (): string => outputs[i++] as string;
    let r = tick(initialSchedulerState, "cmd", base, { now: 0, minIntervalMs: 1000, run });
    expect(r.state.lastOutput).toBe("a");
    r = tick(r.state, "cmd", { ...base, costUsd: 0.9 }, { now: 2000, minIntervalMs: 1000, run });
    expect(r.recomputed).toBe(true);
    expect(r.state.lastOutput).toBe("b");
  });
});
