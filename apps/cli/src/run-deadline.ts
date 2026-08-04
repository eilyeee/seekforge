/**
 * Per-run wall-clock budget.
 *
 * The run already has a cost cap, a turn cap and a tool-call cap, and all three
 * are checked when something happens. Time is the one budget that keeps
 * spending while nothing happens: a command with no timeout, an MCP server that
 * stopped answering, a model call retrying into a wall. Those runs emit no
 * events, so an event-driven check never fires — which is why this is a timer
 * and not another `isXExceeded` call on the event stream.
 *
 * The deadline covers the whole invocation, not one turn. A multi-turn
 * stream-json session is still one thing the user launched and walked away
 * from; restarting the clock per turn would give it no bound at all.
 */

/** Pure: the deadline in ms, or undefined when no budget applies. */
export function resolveDurationBudgetMs(
  flagSeconds: number | undefined,
  configSeconds: number | undefined,
): number | undefined {
  const seconds = flagSeconds ?? configSeconds;
  // Non-positive is "no budget" rather than an instant stop — same reading the
  // cost budget gives a zero, and the only one that can't surprise anybody.
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1_000);
}

/** How long the run actually took when the deadline fired, for the stop message. */
export function elapsedSeconds(startedAt: number, now: number): string {
  return ((now - startedAt) / 1_000).toFixed(1);
}
