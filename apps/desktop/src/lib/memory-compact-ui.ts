export const MAX_MEMORY_PRUNE_DAYS = Math.floor(Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1000));

export function parseMemoryPruneDays(text: string): number | undefined {
  const normalized = text.trim();
  if (normalized === "") return undefined;
  if (!/^[0-9]{1,9}$/.test(normalized)) throw new Error("Prune days must be a non-negative integer");
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value > MAX_MEMORY_PRUNE_DAYS) {
    throw new Error(`Prune days must not exceed ${MAX_MEMORY_PRUNE_DAYS}`);
  }
  return value;
}

export function memoryCompactOptions(text: string, dryRun: boolean): { dryRun: boolean; pruneUnusedDays?: number } {
  const pruneUnusedDays = parseMemoryPruneDays(text);
  return { dryRun, ...(pruneUnusedDays === undefined ? {} : { pruneUnusedDays }) };
}
