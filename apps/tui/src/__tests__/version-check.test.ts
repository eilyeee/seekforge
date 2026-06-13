import { describe, expect, it } from "vitest";
// Pure-logic tests for the CLI's update notifier. The helpers live in the CLI
// package (apps/cli/src/version-check.ts); imported here by relative path since
// the TUI is the only app wired with vitest.
import { formatUpdateNotice, isCacheFresh, isNewer } from "../../../cli/src/version-check.js";

describe("isNewer", () => {
  const cases: Array<[string, string, boolean]> = [
    ["0.8.0", "0.7.0", true],
    ["0.7.1", "0.7.0", true],
    ["0.10.0", "0.9.0", true], // numeric, not lexicographic
    ["1.0.0", "0.99.99", true],
    ["0.7.0", "0.7.0", false], // equal
    ["0.7.0", "0.8.0", false], // older
    ["0.9.0", "0.10.0", false], // numeric
    ["v0.8.0", "0.7.0", true], // tolerant of leading v
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} > ${b} === ${expected}`, () => {
      expect(isNewer(a, b)).toBe(expected);
    });
  }

  it("treats a prerelease as older than the same release", () => {
    expect(isNewer("0.8.0", "0.8.0-rc.1")).toBe(true);
    expect(isNewer("0.8.0-rc.1", "0.8.0")).toBe(false);
  });

  it("ignores build metadata for the core comparison", () => {
    expect(isNewer("0.8.0+build.5", "0.7.0")).toBe(true);
    expect(isNewer("0.8.0+build.5", "0.8.0")).toBe(false);
  });

  it("never throws on garbage input, returns false", () => {
    expect(isNewer("not-a-version", "0.7.0")).toBe(false);
    expect(isNewer("0.7.0", "")).toBe(false);
    expect(isNewer("", "")).toBe(false);
  });
});

describe("isCacheFresh", () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;

  it("is false with no cache", () => {
    expect(isCacheFresh(null, now)).toBe(false);
  });

  it("is true within the 24h window", () => {
    expect(isCacheFresh({ checkedAt: now - day + 1, latest: "0.8.0" }, now)).toBe(true);
  });

  it("is false once the window has elapsed", () => {
    expect(isCacheFresh({ checkedAt: now - day, latest: "0.8.0" }, now)).toBe(false);
    expect(isCacheFresh({ checkedAt: now - day - 1, latest: "0.8.0" }, now)).toBe(false);
  });

  it("honors a custom interval", () => {
    expect(isCacheFresh({ checkedAt: now - 5000, latest: "0.8.0" }, now, 10_000)).toBe(true);
    expect(isCacheFresh({ checkedAt: now - 5000, latest: "0.8.0" }, now, 1000)).toBe(false);
  });
});

describe("formatUpdateNotice", () => {
  it("includes both versions and the install command", () => {
    const line = formatUpdateNotice("0.8.0", "0.7.0");
    expect(line).toContain("seekforge 0.8.0 available");
    expect(line).toContain("you have 0.7.0");
    expect(line).toContain("npm i -g seekforge");
  });
});
