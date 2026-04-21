/**
 * Cost-budget warnings for the TUI process. `costBudgetUsd` in config sets a
 * cumulative budget; the app calls checkBudget whenever total usage changes
 * and shows the returned warning (if any) once per threshold.
 */
export type BudgetState = { warned80: boolean; warnedOver: boolean };

/**
 * Returns the next state and at most one warning line. Crossing 80% of the
 * budget warns once; crossing 100% warns once more. With no budget set (or a
 * non-positive one) the state passes through unchanged and warning is null.
 * Idempotent: already-fired thresholds never fire again.
 */
export function checkBudget(
  state: BudgetState,
  costUsd: number,
  budgetUsd: number | undefined,
): { state: BudgetState; warning: string | null } {
  if (budgetUsd === undefined || budgetUsd <= 0) return { state, warning: null };
  const cost = `$${costUsd.toFixed(2)}`;
  const budget = `$${budgetUsd.toFixed(2)}`;
  if (!state.warnedOver && costUsd >= budgetUsd) {
    return {
      state: { warned80: true, warnedOver: true },
      warning: `cost budget exceeded: ${cost} of ${budget}`,
    };
  }
  if (!state.warned80 && costUsd >= budgetUsd * 0.8 && costUsd < budgetUsd) {
    return {
      state: { ...state, warned80: true },
      warning: `cost ${cost} of ${budget} budget (80%)`,
    };
  }
  return { state, warning: null };
}
