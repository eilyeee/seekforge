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
});
