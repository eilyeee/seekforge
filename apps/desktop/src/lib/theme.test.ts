import { describe, expect, it } from "vitest";
import {
  dataThemeAttr,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  type ThemeChoice,
} from "./theme";

describe("readThemeChoice", () => {
  it("passes through valid stored choices", () => {
    expect(readThemeChoice("dark")).toBe("dark");
    expect(readThemeChoice("light")).toBe("light");
    expect(readThemeChoice("system")).toBe("system");
  });

  it("defaults to system for unset/garbage", () => {
    expect(readThemeChoice(null)).toBe("system");
    expect(readThemeChoice("")).toBe("system");
    expect(readThemeChoice("solarized")).toBe("system");
  });
});

describe("nextThemeChoice", () => {
  it("cycles dark -> light -> system -> dark", () => {
    expect(nextThemeChoice("dark")).toBe("light");
    expect(nextThemeChoice("light")).toBe("system");
    expect(nextThemeChoice("system")).toBe("dark");
  });
});

describe("resolveTheme", () => {
  it("passes explicit choices through regardless of OS", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
  });

  it("follows the OS preference for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("dataThemeAttr", () => {
  it("maps light -> 'light' and dark -> null (default :root)", () => {
    expect(dataThemeAttr("light")).toBe("light");
    expect(dataThemeAttr("dark")).toBeNull();
  });

  it("every resolved system outcome yields a valid attribute", () => {
    const choices: ThemeChoice[] = ["dark", "light", "system"];
    for (const c of choices) {
      const attr = dataThemeAttr(resolveTheme(c, true));
      expect(attr === null || attr === "light").toBe(true);
    }
  });
});
