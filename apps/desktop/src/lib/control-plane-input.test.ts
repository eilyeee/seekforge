import { describe, expect, it } from "vitest";
import { parseControlPlaneScenarioInput } from "./control-plane-input";

describe("control-plane scenario input", () => {
  it("accepts an array or a scenarios envelope", () => {
    expect(parseControlPlaneScenarioInput('[{"id":"one"}]')).toEqual([{ id: "one" }]);
    expect(parseControlPlaneScenarioInput('{"scenarios":[{"id":"one"}]}')).toEqual([{ id: "one" }]);
  });

  it("rejects scalar, empty, and oversized inputs", () => {
    expect(() => parseControlPlaneScenarioInput("null")).toThrow(/1-32/);
    expect(() => parseControlPlaneScenarioInput("[]")).toThrow(/1-32/);
    expect(() => parseControlPlaneScenarioInput(" ".repeat(256 * 1024 + 1))).toThrow(/too large/);
  });
});
