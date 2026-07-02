import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, modelPickerLines, modelsForProvider } from "../model-list.js";

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

describe("modelsForProvider", () => {
  it("returns the Ark catalog (11 ids) for provider 'ark'", () => {
    const models = modelsForProvider("ark");
    expect(models.map((m) => m.id)).toEqual([
      "doubao-seed-2.0-code",
      "doubao-seed-2.0-pro",
      "doubao-seed-2.0-lite",
      "doubao-seed-2.0-mini",
      "glm-5.2",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "minimax-m3",
      "minimax-m2.7",
    ]);
    expect(models.every((m) => m.note === "ark model")).toBe(true);
  });

  it("returns KNOWN_MODELS for an unset, deepseek, or unknown provider", () => {
    expect(modelsForProvider(undefined)).toBe(KNOWN_MODELS);
    expect(modelsForProvider("deepseek")).toBe(KNOWN_MODELS);
    expect(modelsForProvider("openai")).toBe(KNOWN_MODELS);
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
