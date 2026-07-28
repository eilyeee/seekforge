import type { GraphFunctionHandler } from "./graph-engineering.js";

/** Deterministic handlers shared by the CLI and Server Graph adapters. */
export const BUILTIN_GRAPH_HANDLERS: Readonly<Record<string, GraphFunctionHandler>> = Object.freeze({
  noop: () => ({ output: null }),
  collect: ({ dependencies }) => ({
    output: Object.fromEntries([...dependencies].map(([id, result]) => [id, result.output])),
  }),
});
