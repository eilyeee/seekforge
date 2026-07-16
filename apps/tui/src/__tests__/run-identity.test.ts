import { describe, expect, it } from "vitest";
import {
  cancelRun,
  interruptRun,
  ownsRun,
  releaseRun,
  reserveRun,
  takeRunOwned,
  type RunEntry,
} from "../run-identity.js";

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

  it("does not let an old detached run consume a replacement run's prompt", () => {
    const prompts = new Map<number, { runId: number; value: string }>();
    prompts.set(1, { runId: 11, value: "new prompt" });

    expect(takeRunOwned(prompts, 1, 10)).toBeNull();
    expect(prompts.get(1)?.value).toBe("new prompt");
    expect(takeRunOwned(prompts, 1, 11)?.value).toBe("new prompt");
    expect(prompts.has(1)).toBe(false);
  });

  it("cancels the matching run while its permission prompt is open", () => {
    const runs = new Map<number, RunEntry>();
    const run = reserveRun(runs, 1, 10)!;
    let permissionResult: boolean | undefined;
    const permissions = new Map([
      [
        1,
        {
          runId: 10,
          resolve: (result: false) => {
            permissionResult = result;
          },
        },
      ],
    ]);

    const result = cancelRun(runs, permissions, new Map(), 1);

    expect(result).toEqual({ sigintCount: 1, permissionCancelled: true, questionCancelled: false });
    expect(permissionResult).toBe(false);
    expect(run.controller.signal.aborted).toBe(true);
    expect(permissions.has(1)).toBe(false);
  });

  it("does not resolve a stale prompt belonging to another run", () => {
    const runs = new Map<number, RunEntry>();
    reserveRun(runs, 1, 11);
    let resolved = false;
    const permissions = new Map([
      [
        1,
        {
          runId: 10,
          resolve: () => {
            resolved = true;
          },
        },
      ],
    ]);

    cancelRun(runs, permissions, new Map(), 1);

    expect(resolved).toBe(false);
    expect(permissions.has(1)).toBe(true);
  });
});
