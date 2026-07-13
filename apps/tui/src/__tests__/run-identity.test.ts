import { describe, expect, it } from "vitest";
import { interruptRun, ownsRun, releaseRun, reserveRun, type RunEntry } from "../run-identity.js";

describe("run identity", () => {
  it("reserves the originating tab across an async prompt and rejects another run there", () => {
    const runs = new Map<number, RunEntry>();
    const promptRun = reserveRun(runs, 1, 10)!;

    expect(reserveRun(runs, 1, 11)).toBeNull();
    expect(reserveRun(runs, 2, 12)).not.toBeNull();
    expect(ownsRun(runs, promptRun)).toBe(true);
  });

  it("does not let stale async cleanup release a replacement run", () => {
    const runs = new Map<number, RunEntry>();
    const stale = reserveRun(runs, 1, 10)!;
    runs.set(1, { runId: 11, controller: new AbortController(), sigintCount: 0 });

    expect(releaseRun(runs, stale)).toBe(false);
    expect(runs.get(1)?.runId).toBe(11);
  });

  it("counts Ctrl+C independently for each run identity", () => {
    const runs = new Map<number, RunEntry>();
    const first = reserveRun(runs, 1, 10)!;
    const second = reserveRun(runs, 2, 11)!;

    expect(interruptRun(runs, 1)).toBe(1);
    expect(interruptRun(runs, 2)).toBe(1);
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(true);
    expect(interruptRun(runs, 1)).toBe(2);
  });
});
