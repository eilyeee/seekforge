import { describe, expect, it } from "vitest";
import { ghostSuggestion } from "../suggestion.js";

describe("ghostSuggestion", () => {
  const history = ["run the tests", "fix the parser bug", "run the linter"];

  it("returns the remainder of the newest entry starting with the input", () => {
    // Both "run the tests" and "run the linter" match; newest wins.
    expect(ghostSuggestion("run", history)).toBe(" the linter");
    expect(ghostSuggestion("run the t", history)).toBe("ests");
  });

  it("returns null when nothing matches", () => {
    expect(ghostSuggestion("deploy", history)).toBeNull();
  });

  it("requires at least 3 characters of input", () => {
    expect(ghostSuggestion("ru", history)).toBeNull();
    expect(ghostSuggestion("", history)).toBeNull();
    expect(ghostSuggestion("run", history)).not.toBeNull();
  });

  it("rejects multiline input", () => {
    expect(ghostSuggestion("run\nthe", ["run\nthe tests"])).toBeNull();
  });

  it("never suggests an entry identical to the input", () => {
    expect(ghostSuggestion("run the tests", history)).toBeNull();
  });

  it("skips an identical newest entry but still finds an older extension", () => {
    expect(ghostSuggestion("run the tests", ["run the tests --watch", "run the tests"])).toBe(" --watch");
  });

  it("matches strictly by prefix (case-sensitive)", () => {
    expect(ghostSuggestion("Run", history)).toBeNull();
  });

  it("returns null on empty history", () => {
    expect(ghostSuggestion("anything", [])).toBeNull();
  });
});
