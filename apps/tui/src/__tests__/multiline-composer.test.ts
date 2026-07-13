import { describe, expect, it } from "vitest";
import { splitLineAtCursor } from "../components/MultilineComposer.js";

describe("splitLineAtCursor", () => {
  it("renders an astral character as one cursor cell value", () => {
    expect(splitLineAtCursor("😀a", 0)).toEqual({ before: "", at: "😀", after: "a" });
    expect(splitLineAtCursor("😀a", 1)).toEqual({ before: "", at: "😀", after: "a" });
    expect(splitLineAtCursor("😀a", 2)).toEqual({ before: "😀", at: "a", after: "" });
  });

  it("renders a trailing cursor without consuming text", () => {
    expect(splitLineAtCursor("你a", 2)).toEqual({ before: "你a", at: " ", after: "" });
  });
});
