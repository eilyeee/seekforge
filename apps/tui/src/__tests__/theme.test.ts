import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INK_COLORS, loadTheme } from "../theme.js";

describe("loadTheme", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.SEEKFORGE_TUI_ACCENT;
    delete process.env.SEEKFORGE_TUI_ACCENT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.SEEKFORGE_TUI_ACCENT;
    else process.env.SEEKFORGE_TUI_ACCENT = saved;
  });

  it("defaults to cyan", () => {
    expect(loadTheme()).toEqual({ accent: "cyan" });
  });

  it("uses the config argument when valid", () => {
    expect(loadTheme("magenta")).toEqual({ accent: "magenta" });
  });

  it("lets the env var override the config argument", () => {
    process.env.SEEKFORGE_TUI_ACCENT = "yellowBright";
    expect(loadTheme("magenta")).toEqual({ accent: "yellowBright" });
  });

  it("falls back to cyan for invalid values", () => {
    expect(loadTheme("hotpink")).toEqual({ accent: "cyan" });
    process.env.SEEKFORGE_TUI_ACCENT = "not-a-color";
    expect(loadTheme()).toEqual({ accent: "cyan" });
  });

  it("exposes the valid ink color names", () => {
    expect(INK_COLORS).toContain("cyan");
    expect(INK_COLORS).toContain("redBright");
    expect(INK_COLORS).not.toContain("hotpink");
  });
});
