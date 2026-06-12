import { describe, expect, it } from "vitest";
import { detectThinkingKeyword } from "../../src/agent/index.js";

describe("detectThinkingKeyword", () => {
  it("maps the strongest triggers to max", () => {
    expect(detectThinkingKeyword("please ultrathink this")).toBe("max");
    expect(detectThinkingKeyword("think harder about it")).toBe("max");
    expect(detectThinkingKeyword("THINK REALLY HARD")).toBe("max");
  });

  it("maps mid triggers to high", () => {
    expect(detectThinkingKeyword("think hard here")).toBe("high");
    expect(detectThinkingKeyword("megathink this one")).toBe("high");
    expect(detectThinkingKeyword("think step by step")).toBe("high");
  });

  it("returns undefined without a trigger", () => {
    expect(detectThinkingKeyword("just do it")).toBeUndefined();
    expect(detectThinkingKeyword("I think this is fine")).toBeUndefined();
  });

  it("prefers max when both ladders match", () => {
    expect(detectThinkingKeyword("think hard, actually ultrathink")).toBe("max");
  });
});
