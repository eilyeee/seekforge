import { describe, expect, it } from "vitest";
import {
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  buildTitleSequence,
  parseMouseWheel,
} from "../terminal.js";

describe("mouse sequences", () => {
  it("enables button tracking + SGR, and disables in reverse order", () => {
    expect(MOUSE_ENABLE).toBe("\x1b[?1000h\x1b[?1006h");
    expect(MOUSE_DISABLE).toBe("\x1b[?1006l\x1b[?1000l");
  });
});

describe("parseMouseWheel", () => {
  it("parses wheel up (64) and down (65)", () => {
    expect(parseMouseWheel("\x1b[<64;10;5M")).toBe("up");
    expect(parseMouseWheel("\x1b[<65;1;1M")).toBe("down");
  });

  it("finds the first wheel event in a chunk with multiple sequences", () => {
    expect(parseMouseWheel("\x1b[<0;3;3M\x1b[<65;3;3M\x1b[<64;3;3M")).toBe("down");
  });

  it("tolerates surrounding garbage and partial sequences", () => {
    expect(parseMouseWheel("junk\x1b[<64;12;34Mtrailing\x1b[<65;")).toBe("up");
  });

  it("returns null for non-wheel buttons, garbage, and partials", () => {
    expect(parseMouseWheel("\x1b[<0;10;5M")).toBe(null); // left click
    expect(parseMouseWheel("\x1b[<66;10;5M")).toBe(null); // not a wheel code
    expect(parseMouseWheel("\x1b[<64;10;5")).toBe(null); // partial, no final M
    expect(parseMouseWheel("hello")).toBe(null);
    expect(parseMouseWheel("")).toBe(null);
  });
});

describe("buildTitleSequence", () => {
  it("wraps the title in OSC 0 ... BEL", () => {
    expect(buildTitleSequence("seekforge — fix bug")).toBe("\x1b]0;seekforge — fix bug\x07");
  });

  it("strips control characters from the title", () => {
    expect(buildTitleSequence("evil\x1b]0;pwn\x07\ntitle")).toBe("\x1b]0;evil]0;pwntitle\x07");
  });
});
