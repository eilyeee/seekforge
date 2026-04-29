import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INK_COLORS, THEME_PRESETS, loadTheme, themePickerLines } from "../theme.js";

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

  it("resolves preset names to their accent + dim", () => {
    expect(loadTheme("deepseek")).toEqual({ accent: "blueBright", dim: "gray" });
    expect(loadTheme("mono")).toEqual({ accent: "white", dim: "gray" });
    expect(loadTheme("solarized")).toEqual({ accent: "blue", dim: "gray" });
    expect(loadTheme("matrix")).toEqual({ accent: "green", dim: "green" });
    expect(loadTheme("default")).toEqual({ accent: "cyan" });
  });

  it("lets the env var name a preset", () => {
    process.env.SEEKFORGE_TUI_ACCENT = "deepseek";
    expect(loadTheme("magenta").accent).toBe("blueBright");
  });
});

describe("THEME_PRESETS", () => {
  it("includes the documented preset set", () => {
    expect(Object.keys(THEME_PRESETS)).toEqual(
      expect.arrayContaining(["default", "deepseek", "mono", "solarized", "matrix"]),
    );
  });

  it("only uses valid ink accent colors", () => {
    for (const preset of Object.values(THEME_PRESETS)) {
      expect(INK_COLORS).toContain(preset.accent);
      if (preset.dim) expect(INK_COLORS).toContain(preset.dim);
    }
  });
});

describe("themePickerLines", () => {
  it("renders one line per preset and marks the current one", () => {
    const lines = themePickerLines("deepseek");
    expect(lines).toHaveLength(Object.keys(THEME_PRESETS).length);
    const active = lines.filter((l) => l.startsWith("●"));
    expect(active).toHaveLength(1);
    expect(active[0]).toContain("deepseek");
    expect(active[0]).toContain("blueBright");
  });

  it("matches a raw accent color against preset accents", () => {
    const lines = themePickerLines("green");
    expect(lines.find((l) => l.includes("matrix"))).toMatch(/^●/);
    expect(lines.find((l) => l.includes("mono"))).toMatch(/^○/);
  });
});
