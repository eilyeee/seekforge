import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, modelPickerLines } from "../model-list.js";

describe("KNOWN_MODELS", () => {
  it("lists the V4 models first, legacy models after", () => {
    expect(KNOWN_MODELS.map((m) => m.id)).toEqual([
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-chat",
      "deepseek-coder",
      "deepseek-reasoner",
    ]);
    expect(KNOWN_MODELS[0]?.note).toContain("thinking");
    expect(KNOWN_MODELS[4]?.note).toContain("no tool calling");
  });
});

describe("modelPickerLines", () => {
  it("marks the current model and keeps order", () => {
    const lines = modelPickerLines(KNOWN_MODELS, "deepseek-v4-pro");
    expect(lines).toHaveLength(5);
    expect(lines[0]?.startsWith("● deepseek-v4-pro")).toBe(true);
    expect(lines[1]?.startsWith("○ deepseek-v4-flash")).toBe(true);
  });

  it("marks nothing when current is unknown", () => {
    const lines = modelPickerLines(KNOWN_MODELS, "gpt-4");
    expect(lines.every((l) => l.startsWith("○ "))).toBe(true);
  });
});
