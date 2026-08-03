import { addUsage, ZERO_USAGE, type TokenUsage } from "@seekforge/shared";

/**
 * A place to put tokens spent outside the agent loop.
 *
 * The loop totals what it spends by reading each provider response, which
 * covers everything it initiates — including compaction and memory extraction.
 * It cannot see a call made by something else during a tool call, and the one
 * that exists is an MCP server borrowing the user's model through
 * `sampling/createMessage`.
 *
 * Reporting that on stderr and leaving it out of the session total would hide
 * cost, which this project does not do. The bus is created once per session,
 * handed to whatever spends outside the loop, and drained by the loop whenever
 * it reports — so the tokens land in the same place as every other token.
 */
export type UsageBus = {
  /** Add usage spent outside the loop; safe to call at any time. */
  record(usage: TokenUsage): void;
  /** Take everything recorded since the last drain, leaving the bus empty. */
  drain(): TokenUsage;
};

export function createUsageBus(): UsageBus {
  let pending = ZERO_USAGE;
  return {
    record(usage: TokenUsage): void {
      pending = addUsage(pending, usage);
    },
    drain(): TokenUsage {
      const taken = pending;
      pending = ZERO_USAGE;
      return taken;
    },
  };
}
