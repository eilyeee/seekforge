import { MAX_TIMER_DELAY_MS } from "@seekforge/shared/timers";
import { describe, expect, it } from "vitest";
import { createRecurringIdleTimer, idleTimerDelay } from "../../src/agent/idle-scheduler.js";

describe("idleTimerDelay", () => {
  it("accepts the timer ceiling and rejects one millisecond past it", () => {
    expect(idleTimerDelay(MAX_TIMER_DELAY_MS, 1, "delay", false)).toBe(MAX_TIMER_DELAY_MS);
    expect(() => idleTimerDelay(MAX_TIMER_DELAY_MS + 1, 1, "delay", false)).toThrow(RangeError);
  });

  it("names the ceiling it enforced, because the rejected value is a safe integer", () => {
    // The old message said "must be a positive safe integer" about a value that
    // is one, sending the reader after the wrong bug.
    expect(() => idleTimerDelay(MAX_TIMER_DELAY_MS + 1, 1, "graphMaintenanceIntervalMs", false)).toThrow(
      new RegExp(`graphMaintenanceIntervalMs .*no greater than ${MAX_TIMER_DELAY_MS}`),
    );
  });

  it("bounds the fallback too, not only the caller's value", () => {
    expect(() => idleTimerDelay(undefined, MAX_TIMER_DELAY_MS + 1, "delay", true)).toThrow(RangeError);
  });

  /**
   * The reject site's negative control, stated as an effect.
   *
   * `idleTimerDelay` exists so that every delay it returns is one a timer will
   * actually wait for. Checking only that a large value throws would pass
   * against a guard whose accepted range still overflows, so this schedules a
   * real timer at the largest value the guard hands back and watches it: an
   * off-by-one ceiling fires the maintenance callback on the next tick instead
   * of in 24.8 days, which is a busy loop, not a late timer.
   */
  it("never returns a delay that fires immediately", async () => {
    const runs: number[] = [];
    const timer = createRecurringIdleTimer({
      initialDelayMs: idleTimerDelay(undefined, MAX_TIMER_DELAY_MS, "initialDelayMs", false),
      intervalMs: idleTimerDelay(undefined, MAX_TIMER_DELAY_MS, "intervalMs", false),
      run: () => runs.push(Date.now()),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runs).toEqual([]);
    } finally {
      timer.dispose();
    }
  });
});
