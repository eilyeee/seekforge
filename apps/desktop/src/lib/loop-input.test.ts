import { describe, expect, it } from "vitest";
import { parseBudgetInput, parseIterationInput } from "./loop-input";

describe("loop numeric input", () => {
  it("accepts only complete finite iteration numbers", () => {
    expect(parseIterationInput("8")).toEqual({ value: 8 });
    expect(parseIterationInput("8oops")).toEqual({ error: "integer" });
    expect(parseIterationInput("1.5")).toEqual({ error: "integer" });
    expect(parseIterationInput("101")).toEqual({ error: "integer" });
  });

  it("allows omitted optional values but rejects non-positive budgets", () => {
    expect(parseIterationInput("", true)).toEqual({});
    expect(parseBudgetInput(" ")).toEqual({});
    expect(parseBudgetInput("1.25")).toEqual({ value: 1.25 });
    expect(parseBudgetInput("0")).toEqual({ error: "positive" });
    expect(parseBudgetInput("1e999")).toEqual({ error: "positive" });
  });
});
