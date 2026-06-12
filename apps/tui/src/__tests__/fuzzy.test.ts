import { describe, expect, it } from "vitest";
import { fuzzyRank, fuzzyScore } from "../fuzzy.js";

describe("fuzzyScore", () => {
  it("matches case-insensitive subsequences", () => {
    expect(fuzzyScore("mdl", "Model")).not.toBeNull();
    expect(fuzzyScore("ABC", "a-b-c")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "model")).toBeNull();
    expect(fuzzyScore("modell", "model")).toBeNull();
  });

  it("empty query scores 0 against anything", () => {
    expect(fuzzyScore("", "whatever")).toBe(0);
    expect(fuzzyScore("", "")).toBe(0);
  });

  it("ranks a start-of-text match above a mid-word one", () => {
    const model = fuzzyScore("mod", "model");
    const remodel = fuzzyScore("mod", "remodel");
    expect(model).not.toBeNull();
    expect(remodel).not.toBeNull();
    expect(model as number).toBeGreaterThan(remodel as number);
  });

  it("gives a boundary bonus after separators", () => {
    const afterSep = fuzzyScore("m", "src/model");
    const midWord = fuzzyScore("m", "summer");
    expect(afterSep as number).toBeGreaterThan(midWord as number);
  });
});

describe("fuzzyRank", () => {
  it("sorts by score descending and drops misses", () => {
    const items = ["remodel", "model", "nothing"];
    expect(fuzzyRank("mod", items, (s) => s)).toEqual(["model", "remodel"]);
  });

  it("is stable for equal scores", () => {
    const items = ["abc1", "abc2", "abc3"];
    expect(fuzzyRank("abc", items, (s) => s)).toEqual(["abc1", "abc2", "abc3"]);
  });

  it("applies the limit", () => {
    const items = ["a1", "a2", "a3"];
    expect(fuzzyRank("a", items, (s) => s, 2)).toEqual(["a1", "a2"]);
  });

  it("empty query keeps every item in order", () => {
    const items = ["z", "a", "m"];
    expect(fuzzyRank("", items, (s) => s)).toEqual(["z", "a", "m"]);
  });
});
