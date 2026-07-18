export const MAX_LOOP_ITERATIONS = 100;

export type NumericInput = { value?: number; error?: "integer" | "positive" };

export function parseIterationInput(raw: string, optional = false): NumericInput {
  const text = raw.trim();
  if (optional && text === "") return {};
  if (!/^[0-9]+$/.test(text)) return { error: "integer" };
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > MAX_LOOP_ITERATIONS) {
    return { error: "integer" };
  }
  return { value };
}

export function parseBudgetInput(raw: string): NumericInput {
  const text = raw.trim();
  if (text === "") return {};
  if (!/^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text)) {
    return { error: "positive" };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { error: "positive" };
  return { value };
}
