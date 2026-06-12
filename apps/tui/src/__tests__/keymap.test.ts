import { describe, expect, it } from "vitest";
import { resolveAction, toStroke, type InkKey } from "../keymap.js";

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

function key(overrides: Partial<InkKey>): InkKey {
  return { ...NO_KEY, ...overrides };
}

describe("toStroke", () => {
  it("maps named keys", () => {
    expect(toStroke("", key({ return: true })).name).toBe("return");
    expect(toStroke("", key({ escape: true })).name).toBe("escape");
    expect(toStroke("", key({ pageUp: true })).name).toBe("pageup");
  });

  it("keeps modifiers and lowercases ctrl chords", () => {
    const s = toStroke("C", key({ ctrl: true }));
    expect(s).toEqual({ input: "c", ctrl: true });
  });

  it("plain printable input has no name", () => {
    expect(toStroke("x", NO_KEY)).toEqual({ input: "x" });
  });
});

describe("resolveAction", () => {
  it("routes composer keys", () => {
    expect(resolveAction("composer", { input: "", name: "return" })).toBe("submit");
    expect(resolveAction("composer", { input: "j", ctrl: true })).toBe("newline");
    expect(resolveAction("composer", { input: "u", ctrl: true })).toBe("clear-line");
    expect(resolveAction("composer", { input: "", name: "up" })).toBe("history-up");
    expect(resolveAction("composer", { input: "g", ctrl: true })).toBe("external-editor");
  });

  it("routes overlay keys, which differ from composer ones", () => {
    expect(resolveAction("overlay", { input: "", name: "return" })).toBe("overlay-accept");
    expect(resolveAction("overlay", { input: "", name: "tab" })).toBe("overlay-accept");
    expect(resolveAction("overlay", { input: "", name: "escape" })).toBe("overlay-close");
    expect(resolveAction("overlay", { input: "", name: "up" })).toBe("overlay-up");
  });

  it("falls back to global bindings in any scope", () => {
    expect(resolveAction("composer", { input: "c", ctrl: true })).toBe("cancel-or-quit");
    expect(resolveAction("overlay", { input: "", name: "pageup" })).toBe("scroll-up");
    expect(resolveAction("composer", { input: "", name: "tab", shift: true })).toBe("cycle-approval");
  });

  it("returns undefined for unbound printable input", () => {
    expect(resolveAction("composer", { input: "x" })).toBeUndefined();
  });
});
