import { describe, expect, it } from "vitest";
import {
  assertNonOverlappingOrchestrationPaths,
  isDenseArray,
  orchestrationDescendantClosure,
  orchestrationDependsOn,
  orchestrationPathsOverlap,
  validateOrchestrationSelection,
} from "../../src/agent/orchestration.js";

describe("orchestration primitives", () => {
  it("validates bounded dense selections", () => {
    const knownIds = new Set(["a", "b"]);
    const isValidId = (value: unknown): value is string => typeof value === "string" && /^[a-z]$/.test(value);
    expect(validateOrchestrationSelection(["a", "b"], { label: "selection", max: 2, knownIds, isValidId })).toEqual([
      "a",
      "b",
    ]);
    expect(isDenseArray(new Array(1))).toBe(false);
    expect(() =>
      validateOrchestrationSelection(new Array(1), { label: "selection", max: 2, knownIds, isValidId }),
    ).toThrow(/unique existing/);
  });

  it("finds transitive dependants", () => {
    expect([
      ...orchestrationDescendantClosure(
        [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }, { id: "other" }],
        ["b"],
      ),
    ]).toEqual(["b", "c"]);
  });

  it("detects transitive dependency ordering", () => {
    const nodes = [{ id: "a" }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: ["b"] }];
    expect(orchestrationDependsOn(nodes, "c", "a")).toBe(true);
    expect(orchestrationDependsOn(nodes, "a", "c")).toBe(false);
  });

  it("rejects equal and ancestor workspaces while allowing siblings", () => {
    expect(orchestrationPathsOverlap("/repo/a", "/repo/a")).toBe(true);
    expect(orchestrationPathsOverlap("/repo/a", "/repo/a/child")).toBe(true);
    expect(orchestrationPathsOverlap("/repo/a", "/repo/b")).toBe(false);
    expect(() => assertNonOverlappingOrchestrationPaths(["/repo/a", "/repo/a/child"], "overlap")).toThrow("overlap");
  });
});
