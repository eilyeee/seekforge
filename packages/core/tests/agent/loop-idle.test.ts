import { describe, expect, it, vi } from "vitest";
import type { LoopResult } from "../../src/agent/auto-loop.js";
import {
  createLoopRecoveryScheduler,
  DEFAULT_LOOP_IDLE_CHECK_INTERVAL_MS,
  DEFAULT_LOOP_IDLE_INITIAL_DELAY_MS,
} from "../../src/agent/loop-idle.js";

function result(loopId: string): LoopResult {
  return {
    loopId,
    status: "passed",
    iterations: 0,
    costUsd: 0,
    sessionId: "",
    finalVerify: { code: 0, output: "ok" },
  };
}

describe("idle Loop recovery scheduler", () => {
  it("processes dynamic targets in order and isolates target and observer failures", async () => {
    const calls: string[] = [];
    let includeBusy = true;
    const scheduler = createLoopRecoveryScheduler({
      targets: () => [
        {
          workspace: "failed",
          recover: async () => {
            calls.push("failed");
            throw new Error("recovery failed");
          },
        },
        ...(includeBusy
          ? [
              {
                workspace: "busy",
                recover: async () => {
                  calls.push("busy");
                  return undefined;
                },
              },
            ]
          : []),
        {
          workspace: "ready",
          recover: async () => {
            calls.push("ready");
            return [result("loop-ready")];
          },
        },
      ],
      schedule: () => "timer",
      cancel: () => {},
      onResults: () => {
        throw new Error("observer failed");
      },
    });

    expect(await scheduler.checkNow()).toMatchObject([
      { workspace: "failed", outcome: { status: "failed", error: "recovery failed" } },
      { workspace: "busy", outcome: { status: "busy" } },
      { workspace: "ready", outcome: { status: "completed", results: [{ loopId: "loop-ready" }] } },
    ]);
    expect(calls).toEqual(["failed", "busy", "ready"]);

    includeBusy = false;
    expect((await scheduler.checkNow()).map((entry) => entry.workspace)).toEqual(["failed", "ready"]);
    scheduler.dispose();
  });

  it("never overlaps checks and aborts an owned recovery during disposal", async () => {
    let started = false;
    let aborted = false;
    const scheduler = createLoopRecoveryScheduler({
      targets: () => [
        {
          workspace: "workspace",
          recover: (signal) =>
            new Promise<LoopResult[]>((_resolve, reject) => {
              started = true;
              signal.addEventListener(
                "abort",
                () => {
                  aborted = true;
                  reject(signal.reason);
                },
                { once: true },
              );
            }),
        },
      ],
      schedule: () => "timer",
      cancel: () => {},
    });

    const running = scheduler.checkNow();
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(scheduler.checkNow()).resolves.toEqual([]);
    scheduler.dispose();
    await expect(running).resolves.toEqual([]);
    expect(aborted).toBe(true);
    await expect(scheduler.checkNow()).resolves.toEqual([]);
  });

  it("owns its recurring timer lifecycle", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number; handle: object }> = [];
    const cancel = vi.fn();
    const onResults = vi.fn();
    const scheduler = createLoopRecoveryScheduler({
      targets: () => [],
      schedule: (callback, delayMs) => {
        const handle = {};
        scheduled.push({ callback, delayMs, handle });
        return handle;
      },
      cancel,
      onResults,
    });

    expect(scheduled[0]?.delayMs).toBe(DEFAULT_LOOP_IDLE_INITIAL_DELAY_MS);
    scheduled[0]?.callback();
    await vi.waitFor(() => expect(onResults).toHaveBeenCalledWith([]));
    expect(scheduled[1]?.delayMs).toBe(DEFAULT_LOOP_IDLE_CHECK_INTERVAL_MS);

    scheduler.dispose();
    expect(cancel).toHaveBeenCalledWith(scheduled[1]?.handle);
  });

  it("rejects unsafe timer intervals", () => {
    expect(() => createLoopRecoveryScheduler({ targets: () => [], intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => createLoopRecoveryScheduler({ targets: () => [], initialDelayMs: Number.POSITIVE_INFINITY })).toThrow(
      /initialDelayMs/,
    );
  });
});
