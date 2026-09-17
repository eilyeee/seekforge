import { describe, expect, it, vi } from "vitest";
import { altFromSplit, createEscapeJoiner, isBareEscape } from "../esc-prefix.js";
import type { InkKey } from "../keymap.js";

const NO_KEY: InkKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageUp: false,
  pageDown: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};
const ESC: InkKey = { ...NO_KEY, escape: true, meta: true };

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    timers: {
      set: (fn: () => void) => {
        const id = next++;
        pending.set(id, fn);
        return id;
      },
      clear: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    fire() {
      for (const [id, fn] of [...pending]) {
        pending.delete(id);
        fn();
      }
    },
    size: () => pending.size,
  };
}

describe("esc-prefix helpers", () => {
  it("recognizes a bare Esc", () => {
    expect(isBareEscape("", ESC)).toBe(true);
    expect(isBareEscape("[<64;1;1M", ESC)).toBe(false);
    expect(isBareEscape("", NO_KEY)).toBe(false);
  });

  it("joins only a printable character", () => {
    expect(altFromSplit("p", NO_KEY)).toEqual({ input: "p", key: { ...NO_KEY, meta: true } });
    expect(altFromSplit(" ", NO_KEY)).toBeNull();
    expect(altFromSplit("pp", NO_KEY)).toBeNull();
    expect(altFromSplit("", { ...NO_KEY, return: true })).toBeNull();
    expect(altFromSplit("c", { ...NO_KEY, ctrl: true })).toBeNull();
    expect(altFromSplit("你", NO_KEY)).toBeNull();
  });
});

describe("createEscapeJoiner", () => {
  it("turns a split ESC + letter into Alt+letter", () => {
    const deliver = vi.fn();
    const clock = fakeTimers();
    const joiner = createEscapeJoiner(deliver, 30, clock.timers);
    joiner.feed("", ESC);
    expect(deliver).not.toHaveBeenCalled();
    joiner.feed("p", NO_KEY);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith("p", { ...NO_KEY, meta: true });
    expect(clock.size()).toBe(0);
  });

  it("delivers a lone Esc once the window elapses", () => {
    const deliver = vi.fn();
    const clock = fakeTimers();
    const joiner = createEscapeJoiner(deliver, 30, clock.timers);
    joiner.feed("", ESC);
    clock.fire();
    expect(deliver).toHaveBeenCalledWith("", ESC);
  });

  it("flushes the Esc before a key that cannot be joined", () => {
    const deliver = vi.fn();
    const clock = fakeTimers();
    const joiner = createEscapeJoiner(deliver, 30, clock.timers);
    const up = { ...NO_KEY, upArrow: true };
    joiner.feed("", ESC);
    joiner.feed("", up);
    expect(deliver.mock.calls).toEqual([
      ["", ESC],
      ["", up],
    ]);
    clock.fire();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it("keeps a double Esc as two Esc presses", () => {
    const deliver = vi.fn();
    const clock = fakeTimers();
    const joiner = createEscapeJoiner(deliver, 30, clock.timers);
    joiner.feed("", ESC);
    joiner.feed("", ESC);
    expect(deliver).toHaveBeenCalledTimes(1);
    clock.fire();
    expect(deliver.mock.calls).toEqual([
      ["", ESC],
      ["", ESC],
    ]);
  });

  it("passes ordinary input straight through and drops a pending Esc on dispose", () => {
    const deliver = vi.fn();
    const clock = fakeTimers();
    const joiner = createEscapeJoiner(deliver, 30, clock.timers);
    joiner.feed("x", NO_KEY);
    expect(deliver).toHaveBeenCalledWith("x", NO_KEY);
    joiner.feed("", ESC);
    joiner.dispose();
    clock.fire();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
