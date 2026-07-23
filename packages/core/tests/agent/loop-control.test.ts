import { describe, expect, it } from "vitest";
import { createLoopControl } from "../../src/agent/loop-control.js";

describe("createLoopControl", () => {
  it("pauses at a boundary, resumes, and drains bounded steering guidance", async () => {
    const control = createLoopControl({ maxQueuedGuidance: 2, maxGuidanceLength: 5 });
    control.pause();
    control.steer("first-message");
    control.steer("second");
    control.steer("third");
    const waiting = control.waitAtBoundary();
    control.resume();
    await expect(waiting).resolves.toEqual({ resumed: true, guidance: ["secon", "third"] });
    expect(control.state()).toBe("running");
    await expect(control.waitAtBoundary()).resolves.toEqual({ resumed: false, guidance: [] });
  });

  it("rejects a paused wait when its signal is aborted", async () => {
    const control = createLoopControl();
    const abort = new AbortController();
    control.pause();
    const waiting = control.waitAtBoundary(abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow(/cancelled/);
  });
});
