import { describe, expect, it } from "vitest";
import { getVariant, listVariants, type AgentBuildOptions } from "../src/variants.js";

describe("variant registry", () => {
  it("control is the identity transform", () => {
    const base: AgentBuildOptions = { compaction: "mechanical", taskSuffix: "x" };
    const out = getVariant("control").apply(base);
    expect(out).toEqual(base);
    // …and a fresh object (pure: no mutation, no aliasing).
    expect(out).not.toBe(base);
  });

  it("control on empty base yields empty options", () => {
    expect(getVariant("control").apply({})).toEqual({});
  });

  it("terse-prompt appends a brevity suffix without touching other fields", () => {
    const out = getVariant("terse-prompt").apply({ compaction: "mechanical" });
    expect(out.compaction).toBe("mechanical");
    expect(out.taskSuffix).toContain("variant:terse");
  });

  it("terse-prompt preserves an existing suffix (append, not replace)", () => {
    const out = getVariant("terse-prompt").apply({ taskSuffix: "PRE" });
    expect(out.taskSuffix?.startsWith("PRE")).toBe(true);
    expect(out.taskSuffix).toContain("variant:terse");
  });

  it("llm-compaction flips the compaction strategy only", () => {
    const out = getVariant("llm-compaction").apply({ taskSuffix: "keep" });
    expect(out.compaction).toBe("llm");
    expect(out.taskSuffix).toBe("keep");
  });

  it("apply never mutates the input base", () => {
    const base: AgentBuildOptions = {};
    getVariant("terse-prompt").apply(base);
    getVariant("llm-compaction").apply(base);
    expect(base).toEqual({});
  });

  it("getVariant throws on an unknown name, listing the known ones", () => {
    expect(() => getVariant("nope")).toThrow(/unknown variant "nope"/);
    expect(() => getVariant("nope")).toThrow(/control/);
  });

  it("listVariants includes control first", () => {
    const names = listVariants().map((v) => v.name);
    expect(names[0]).toBe("control");
    expect(names).toContain("terse-prompt");
    expect(names).toContain("llm-compaction");
  });

  it("no-retrieval disables relevant-files injection only", () => {
    const out = getVariant("no-retrieval").apply({ taskSuffix: "keep" });
    expect(out.injectRelevantFiles).toBe(false);
    expect(out.taskSuffix).toBe("keep");
  });

  it("review-gate enables finalizeReview only", () => {
    const out = getVariant("review-gate").apply({ compaction: "mechanical" });
    expect(out.finalizeReview).toBe(true);
    expect(out.compaction).toBe("mechanical");
  });

  it("no-auto-verify sets the verify command but disables auto-run", () => {
    const out = getVariant("no-auto-verify").apply({});
    expect(out.verifyCommand).toBe("npm test");
    expect(out.autoVerify).toBe(false);
  });

  it("model-pro overrides the main model only", () => {
    const out = getVariant("model-pro").apply({ taskSuffix: "keep" });
    expect(out.model).toBe("deepseek-v4-pro");
    expect(out.taskSuffix).toBe("keep");
  });

  it("context-tight sets a 32000-token context window only", () => {
    const out = getVariant("context-tight").apply({ taskSuffix: "keep" });
    expect(out).toEqual({ taskSuffix: "keep", contextWindowTokens: 32000 });
  });

  it("verify-and-review stacks verify + auto-run + finalize review", () => {
    const out = getVariant("verify-and-review").apply({ compaction: "mechanical" });
    expect(out).toEqual({
      compaction: "mechanical",
      verifyCommand: "npm test",
      autoVerify: true,
      finalizeReview: true,
    });
  });

  it("lint-gate sets the lint command only", () => {
    const out = getVariant("lint-gate").apply({ compaction: "mechanical" });
    expect(out.lintCommand).toBe("npm run lint");
    expect(out.compaction).toBe("mechanical");
  });

  it("whole-file-edits sets editFormat=whole only", () => {
    const out = getVariant("whole-file-edits").apply({ taskSuffix: "keep" });
    expect(out).toEqual({ taskSuffix: "keep", editFormat: "whole" });
  });

  it("the new capability variants are registered and listed", () => {
    const names = listVariants().map((v) => v.name);
    expect(names).toContain("context-tight");
    expect(names).toContain("verify-and-review");
    expect(names).toContain("lint-gate");
    expect(names).toContain("whole-file-edits");
  });

  it("the new variants never mutate the input base", () => {
    const base: AgentBuildOptions = {};
    getVariant("no-retrieval").apply(base);
    getVariant("review-gate").apply(base);
    getVariant("no-auto-verify").apply(base);
    getVariant("model-pro").apply(base);
    getVariant("context-tight").apply(base);
    getVariant("verify-and-review").apply(base);
    expect(base).toEqual({});
  });
});
