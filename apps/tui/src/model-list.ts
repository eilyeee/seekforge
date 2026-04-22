/**
 * Known DeepSeek models for the /model picker: a static catalog with one-line
 * notes so the overlay can explain what each model is good for (and warn that
 * deepseek-reasoner cannot drive the tool-calling agent loop).
 */

export type ModelInfo = { id: string; note: string };

export const KNOWN_MODELS: readonly ModelInfo[] = [
  { id: "deepseek-v4-pro", note: "V4 flagship — thinking mode + tool calling" },
  { id: "deepseek-v4-flash", note: "V4 fast — thinking mode + tool calling" },
  { id: "deepseek-chat", note: "legacy general (deprecated 2026-07)" },
  { id: "deepseek-coder", note: "legacy code-tuned" },
  { id: "deepseek-reasoner", note: "legacy — no tool calling, cannot drive the agent" },
];

/** Renders picker lines, marking the current model with a filled dot. */
export function modelPickerLines(models: readonly ModelInfo[], current: string): string[] {
  return models.map((m) => `${m.id === current ? "●" : "○"} ${m.id} — ${m.note}`);
}
