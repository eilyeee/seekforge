export function parseNumberedChoice(input: string, optionCount: number): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const selected = Number(trimmed);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > optionCount) return null;
  return selected - 1;
}

export function parseIndexList(input: string, allowedIndices: readonly number[]): number[] | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const allowed = new Set(allowedIndices);
  const selected: number[] = [];
  for (const token of trimmed.split(",")) {
    const value = token.trim();
    if (!/^\d+$/.test(value)) return null;
    const index = Number(value);
    if (!Number.isSafeInteger(index) || !allowed.has(index)) return null;
    if (!selected.includes(index)) selected.push(index);
  }
  return selected;
}
