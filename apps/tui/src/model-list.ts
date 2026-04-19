/**
 * Known DeepSeek models for the /model picker: a static catalog with one-line
 * notes so the overlay can explain what each model is good for (and warn that
 * deepseek-reasoner cannot drive the tool-calling agent loop).
 */

export type ModelInfo = { id: string; note: string };

export const KNOWN_MODELS: readonly ModelInfo[] = [
  { id: "deepseek-chat", note: "general, tool calling — default" },
  { id: "deepseek-coder", note: "code-tuned" },
  { id: "deepseek-reasoner", note: "no tool calling — cannot drive the agent" },
];

/** Renders picker lines, marking the current model with a filled dot. */
export function modelPickerLines(models: readonly ModelInfo[], current: string): string[] {
  return models.map((m) => `${m.id === current ? "●" : "○"} ${m.id} — ${m.note}`);
}
