import { describe, expect, it } from "vitest";
import { createBufferedDispatch } from "../delta-buffer.js";
import type { ChatAction } from "../model.js";

/** Manual scheduler: collects callbacks, fires on demand. */
function manualClock() {
  const pending: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      pending.push(fn);
      return pending.length - 1;
    },
    cancel: (h: unknown) => {
      const i = h as number;
      pending[i] = () => {};
    },
    tick: () => {
      const fns = pending.splice(0);
      for (const fn of fns) fn();
    },
  };
}

describe("createBufferedDispatch", () => {
  it("coalesces consecutive model deltas into one dispatch per tick", () => {
    const out: ChatAction[] = [];
    const clock = manualClock();
    const b = createBufferedDispatch((a) => out.push(a), 50, clock.schedule, clock.cancel);
    b.dispatch({ type: "model-delta", chunk: "a" });
    b.dispatch({ type: "model-delta", chunk: "b" });
    b.dispatch({ type: "model-delta", chunk: "c" });
    expect(out).toHaveLength(0);
    clock.tick();
    expect(out).toEqual([{ type: "model-delta", chunk: "abc" }]);
  });

  it("flushes buffers before any non-streaming action to preserve order", () => {
    const out: ChatAction[] = [];
    const clock = manualClock();
    const b = createBufferedDispatch((a) => out.push(a), 50, clock.schedule, clock.cancel);
    b.dispatch({ type: "thinking-delta", chunk: "hmm " });
    b.dispatch({ type: "model-delta", chunk: "answer" });
    b.dispatch({ type: "event", event: { type: "tool.started", toolName: "read_file", args: {} } });
    expect(out.map((a) => a.type)).toEqual(["thinking-delta", "model-delta", "event"]);
  });

  it("merges command.output chunks per stream and keeps stream boundaries", () => {
    const out: ChatAction[] = [];
    const clock = manualClock();
    const b = createBufferedDispatch((a) => out.push(a), 50, clock.schedule, clock.cancel);
    b.dispatch({ type: "event", event: { type: "command.output", stream: "stdout", chunk: "a" } });
    b.dispatch({ type: "event", event: { type: "command.output", stream: "stdout", chunk: "b" } });
    b.dispatch({ type: "event", event: { type: "command.output", stream: "stderr", chunk: "e" } });
    clock.tick();
    expect(out).toEqual([
      { type: "event", event: { type: "command.output", stream: "stdout", chunk: "ab" } },
      { type: "event", event: { type: "command.output", stream: "stderr", chunk: "e" } },
    ]);
  });

  it("manual flush drains everything and an empty flush is a no-op", () => {
    const out: ChatAction[] = [];
    const clock = manualClock();
    const b = createBufferedDispatch((a) => out.push(a), 50, clock.schedule, clock.cancel);
    b.flush();
    expect(out).toHaveLength(0);
    b.dispatch({ type: "model-delta", chunk: "tail" });
    b.flush();
    expect(out).toEqual([{ type: "model-delta", chunk: "tail" }]);
    clock.tick(); // armed timer was cancelled; no double dispatch
    expect(out).toHaveLength(1);
  });
});
