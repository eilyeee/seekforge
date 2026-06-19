/**
 * Per-run cost budget: a tiny, pure helper the run loop calls as usage events
 * arrive. It owns no I/O and no abort — the caller tracks cumulative cost and,
 * when this reports the budget is exhausted, aborts the run (the same graceful
 * path Ctrl+C uses) and prints the stop message.
 */

/**
 * Whether cumulative spend has reached or exceeded the budget. Returns false
 * when no budget is set (undefined/<= 0), so callers can keep the feature off
 * by simply not passing one. A non-positive budget is treated as "no budget"
 * rather than an instant stop.
 */
export function isCostBudgetExceeded(cumulativeCostUsd: number, budgetUsd: number | undefined): boolean {
  if (budgetUsd === undefined || budgetUsd <= 0) return false;
  return cumulativeCostUsd >= budgetUsd;
}
