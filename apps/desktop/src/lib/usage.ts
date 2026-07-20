import { ZERO_USAGE, addUsage, type TokenUsage } from "@seekforge/shared";
import { formatCostUsd } from "@seekforge/shared/format";

// addUsage lives in @seekforge/shared (single implementation, shared with core).
export { addUsage };

export function emptyUsage(): TokenUsage {
  return { ...ZERO_USAGE };
}

export const formatUsd = formatCostUsd;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
