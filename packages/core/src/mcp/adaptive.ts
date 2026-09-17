import type { ToolDefinitionForModel } from "@seekforge/shared";
import type { ToolDispatcher } from "../tools/index.js";

/**
 * A dispatcher whose advertised catalog can change during a run (see
 * createMcpAwareDispatcher). The agent loop re-reads the catalog when
 * `revision()` moves. `listForBudget` may advertise fewer definitions than the
 * dispatcher can execute (deferred tools), and `unadvertisedHint` tells the
 * model how to reach one it called anyway.
 */
export type AdaptiveToolDispatcher = ToolDispatcher & {
  revision(): number;
  listForBudget(budgetTokens: number): ToolDefinitionForModel[];
  unadvertisedHint(name: string, advertised: ReadonlySet<string>): string | undefined;
};

/** The dispatcher as an adaptive one, or undefined for a plain (fixed-catalog) dispatcher. */
export function asAdaptiveToolDispatcher(dispatcher: ToolDispatcher): AdaptiveToolDispatcher | undefined {
  const candidate = dispatcher as Partial<AdaptiveToolDispatcher>;
  return typeof candidate.revision === "function" &&
    typeof candidate.listForBudget === "function" &&
    typeof candidate.unadvertisedHint === "function"
    ? (candidate as AdaptiveToolDispatcher)
    : undefined;
}
