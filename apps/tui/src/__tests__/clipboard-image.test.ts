import { describe, expect, it } from "vitest";
import { extractImagePaths, imagePlaceholder } from "../clipboard-image.js";

describe("imagePlaceholder", () => {
  it("formats the marker as [image #N: path]", () => {
    expect(imagePlaceholder(1, ".seekforge/uploads/img-20260612-101530-ab3f.png")).toBe(
      "[image #1: .seekforge/uploads/img-20260612-101530-ab3f.png]",
    );
  });
});

describe("extractImagePaths", () => {
  it("round-trips paths through placeholders embedded in text", () => {
    const a = ".seekforge/uploads/img-20260612-101530-ab3f.png";
    const b = ".seekforge/uploads/img-20260612-101545-9k2x.png";
    const text = `look at ${imagePlaceholder(1, a)} and also ${imagePlaceholder(2, b)} please`;
    expect(extractImagePaths(text)).toEqual([a, b]);
  });

  it("returns [] when there are no markers", () => {
    expect(extractImagePaths("no images here [image] [#1: nope]")).toEqual([]);
  });

  it("ignores malformed markers but keeps valid ones", () => {
    const text = "[image #x: bad.png] [image #3: good.png]";
    expect(extractImagePaths(text)).toEqual(["good.png"]);
  });
});

describe("relative path shape", () => {
  it("placeholder paths use forward slashes under .seekforge/uploads/", () => {
    const marker = imagePlaceholder(1, ".seekforge/uploads/img-20260612-101530-ab3f.png");
    const [p] = extractImagePaths(marker);
    expect(p).toMatch(/^\.seekforge\/uploads\/img-\d{8}-\d{6}-[a-z0-9]{4}\.png$/);
    expect(p?.includes("\\")).toBe(false);
  });
});
