import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, modelPickerLines } from "../model-list.js";

describe("KNOWN_MODELS", () => {
  it("lists the three DeepSeek models with notes", () => {
    expect(KNOWN_MODELS.map((m) => m.id)).toEqual(["deepseek-chat", "deepseek-coder", "deepseek-reasoner"]);
    expect(KNOWN_MODELS[0]?.note).toContain("default");
    expect(KNOWN_MODELS[2]?.note).toContain("no tool calling");
  });
});

describe("modelPickerLines", () => {
  it("marks the current model and keeps order", () => {
    const lines = modelPickerLines(KNOWN_MODELS, "deepseek-coder");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("○ deepseek-chat — general, tool calling — default");
    expect(lines[1]).toBe("● deepseek-coder — code-tuned");
    expect(lines[2]?.startsWith("○ deepseek-reasoner")).toBe(true);
  });

  it("marks nothing when current is unknown", () => {
    const lines = modelPickerLines(KNOWN_MODELS, "gpt-4");
    expect(lines.every((l) => l.startsWith("○ "))).toBe(true);
  });
});
