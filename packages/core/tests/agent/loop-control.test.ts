import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLoopControl } from "../../src/agent/loop-control.js";
import { enqueueLoopControl, readLoopControlEntries } from "../../src/agent/loop-control-store.js";

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

  it("drains local state and guidance without waiting", () => {
    const control = createLoopControl();
    control.pause();
    control.steer("focus here");
    expect(control.drain()).toEqual({ state: "paused", guidance: ["focus here"] });
    expect(control.drain()).toEqual({ state: "paused", guidance: [] });
  });
});

describe("durable Loop controls", () => {
  it("serializes concurrent writers and discards commands from prior runs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-control-"));
    try {
      await Promise.all([
        enqueueLoopControl(workspace, "loop-a", "run-a", { operation: "pause" }),
        enqueueLoopControl(workspace, "loop-a", "run-a", { operation: "resume" }),
        enqueueLoopControl(workspace, "loop-a", "run-a", { operation: "steer", message: " inspect tests " }),
      ]);
      const runA = readLoopControlEntries(workspace, "loop-a", "run-a");
      expect(runA.map((entry) => entry.operation).sort()).toEqual(["pause", "resume", "steer"]);
      expect(runA.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
      await enqueueLoopControl(workspace, "loop-a", "run-b", { operation: "resume" });
      expect(readLoopControlEntries(workspace, "loop-a", "run-a")).toEqual([]);
      expect(readLoopControlEntries(workspace, "loop-a", "run-b")).toMatchObject([
        { operation: "resume", seq: 4, runId: "run-b" },
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not overwrite a malformed mailbox", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-control-"));
    try {
      const root = join(workspace, ".seekforge", "loops");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "loop-a.control.json"), '{"version":1,"entries":"bad"}\n');
      expect(() => readLoopControlEntries(workspace, "loop-a", "run-a")).toThrow(/Invalid Loop control mailbox/);
      await expect(enqueueLoopControl(workspace, "loop-a", "run-a", { operation: "pause" })).rejects.toThrow(
        /Invalid Loop control mailbox/,
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
