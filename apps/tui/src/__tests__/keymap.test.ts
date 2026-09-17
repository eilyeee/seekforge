import { describe, expect, it } from "vitest";
import {
  formatBinding,
  formatStroke,
  KEYMAP,
  resolveAction,
  resolveChord,
  toStroke,
  type Binding,
  type InkKey,
} from "../keymap.js";

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

  it("drops the meta flag Ink sets on every Esc, so escape bindings match", () => {
    // Ink's useInput reports a bare Esc as { escape: true, meta: true }.
    const esc = toStroke("", key({ escape: true, meta: true }));
    expect(esc).toEqual({ input: "", name: "escape" });
    expect(resolveAction("overlay", esc)).toBe("overlay-close");
  });

  it("keeps meta for Alt+letter (ESC-prefixed in one read)", () => {
    expect(toStroke("p", key({ meta: true }))).toEqual({ input: "p", meta: true });
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

  it("binds Alt+P to the model picker and Alt+T to the thinking toggle", () => {
    expect(resolveAction("composer", { input: "p", meta: true })).toBe("model-picker");
    expect(resolveAction("overlay", { input: "t", meta: true })).toBe("toggle-thinking");
    expect(resolveAction("composer", { input: "p" })).toBeUndefined();
  });

  it("ignores chord bindings when resolving a single stroke", () => {
    const table: Binding[] = [
      {
        scope: "composer",
        key: { input: "x", ctrl: true },
        rest: [{ input: "e", ctrl: true }],
        action: "external-editor",
      },
    ];
    expect(resolveAction("composer", { input: "x", ctrl: true }, table)).toBeUndefined();
  });
});

describe("resolveChord", () => {
  const table: Binding[] = [
    ...KEYMAP,
    {
      scope: "composer",
      key: { input: "x", ctrl: true },
      rest: [{ input: "e", ctrl: true }],
      action: "external-editor",
    },
    { scope: "global", key: { input: "x", ctrl: true }, rest: [{ input: "p" }], action: "toggle-pager" },
  ];

  it("reports a pending prefix, a completed chord, and a miss", () => {
    expect(resolveChord("composer", [{ input: "x", ctrl: true }], table)).toEqual({ kind: "pending" });
    expect(
      resolveChord(
        "composer",
        [
          { input: "x", ctrl: true },
          { input: "e", ctrl: true },
        ],
        table,
      ),
    ).toEqual({
      kind: "action",
      action: "external-editor",
    });
    expect(resolveChord("composer", [{ input: "x", ctrl: true }, { input: "p" }], table)).toEqual({
      kind: "action",
      action: "toggle-pager",
    });
    expect(resolveChord("composer", [{ input: "x", ctrl: true }, { input: "q" }], table)).toEqual({ kind: "none" });
    expect(resolveChord("composer", [{ input: "e", ctrl: true }], table)).toEqual({ kind: "none" });
  });

  it("does not start chords from overlay bindings when resolving the composer", () => {
    const overlayOnly: Binding[] = [
      { scope: "overlay", key: { input: "k", ctrl: true }, rest: [{ input: "k" }], action: "overlay-close" },
    ];
    expect(resolveChord("composer", [{ input: "k", ctrl: true }], overlayOnly)).toEqual({ kind: "none" });
  });
});

describe("formatStroke / formatBinding", () => {
  it("prints specs the way parseKeySpec reads them", () => {
    expect(formatStroke({ input: "p", meta: true })).toBe("alt+p");
    expect(formatStroke({ input: "", name: "tab", shift: true })).toBe("shift+tab");
    expect(formatStroke({ input: "A", shift: true })).toBe("shift+a");
    expect(
      formatBinding({
        scope: "composer",
        key: { input: "x", ctrl: true },
        rest: [{ input: "e", ctrl: true }],
        action: "external-editor",
      }),
    ).toBe("ctrl+x ctrl+e");
  });
});
