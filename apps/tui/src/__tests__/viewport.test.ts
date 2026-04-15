import { describe, expect, it } from "vitest";
import { computeWindow } from "../viewport.js";

describe("computeWindow", () => {
  it("pins to the bottom at offset 0", () => {
    expect(computeWindow(10, 0, 4)).toEqual({ start: 6, end: 10, hiddenAbove: 6, hiddenBelow: 0 });
  });

  it("scrolls up by the offset", () => {
    expect(computeWindow(10, 3, 4)).toEqual({ start: 3, end: 7, hiddenAbove: 3, hiddenBelow: 3 });
  });

  it("shows everything when total <= size", () => {
    expect(computeWindow(3, 0, 10)).toEqual({ start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it("clamps an over-large offset to the top", () => {
    expect(computeWindow(10, 99, 4)).toEqual({ start: 0, end: 4, hiddenAbove: 0, hiddenBelow: 6 });
  });

  it("clamps a negative offset to the bottom", () => {
    expect(computeWindow(10, -5, 4)).toEqual({ start: 6, end: 10, hiddenAbove: 6, hiddenBelow: 0 });
  });

  it("clamps offset to 0 when everything fits", () => {
    expect(computeWindow(3, 5, 10)).toEqual({ start: 0, end: 3, hiddenAbove: 0, hiddenBelow: 0 });
  });

  it("handles zero/negative totals and sizes", () => {
    expect(computeWindow(0, 0, 4)).toEqual({ start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
    expect(computeWindow(-3, 0, 4)).toEqual({ start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0 });
    expect(computeWindow(5, 2, 0)).toEqual({ start: 3, end: 3, hiddenAbove: 3, hiddenBelow: 2 });
  });
});
