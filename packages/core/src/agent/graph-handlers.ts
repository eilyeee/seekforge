import type { GraphExecutionAdapter, GraphFunctionHandler } from "./graph-engineering.js";
import type { PluginContributions } from "../plugins/index.js";
import { type BuiltinGraphHandlerId, DECLARATIVE_GRAPH_HANDLERS } from "./graph-declarative-handlers.js";

/**
 * Deterministic handlers shared by the CLI and Server Graph adapters. A graph
 * definition selects one by name from this fixed catalogue and can never
 * contribute executable code; `graph-declarative-handlers.ts` documents how the
 * declarative members read their operands.
 */
export const BUILTIN_GRAPH_HANDLERS: Readonly<Record<BuiltinGraphHandlerId, GraphFunctionHandler>> = Object.freeze({
  noop: () => ({ output: null }),
  collect: ({ dependencies }) => ({
    output: Object.fromEntries([...dependencies].map(([id, result]) => [id, result.output])),
  }),
  ...DECLARATIVE_GRAPH_HANDLERS,
});

export function graphHandlersWithPlugins(
  contributions: Pick<PluginContributions, "graphHandlers">,
): Readonly<Record<string, GraphFunctionHandler>> {
  const handlers: Record<string, GraphFunctionHandler> = { ...BUILTIN_GRAPH_HANDLERS };
  for (const [id, builtin] of Object.entries(contributions.graphHandlers ?? {})) {
    const descriptor = Object.getOwnPropertyDescriptor(BUILTIN_GRAPH_HANDLERS, builtin);
    if (descriptor && "value" in descriptor && typeof descriptor.value === "function") {
      handlers[id] = descriptor.value as GraphFunctionHandler;
    }
  }
  return Object.freeze(handlers);
}

export function graphExecutorsWithPlugins(
  contributions: Pick<PluginContributions, "graphExecutors">,
  registered: Readonly<Record<string, GraphExecutionAdapter>>,
): Readonly<Record<string, GraphExecutionAdapter>> {
  const executors: Record<string, GraphExecutionAdapter> = {};
  for (const [alias, target] of Object.entries(contributions.graphExecutors ?? {})) {
    const descriptor = Object.getOwnPropertyDescriptor(registered, target);
    if (!descriptor || !("value" in descriptor)) continue;
    const executor = descriptor.value as GraphExecutionAdapter;
    // Plugin manifests select capabilities but never widen trust. The host
    // must have registered the exact remote adapter as trusted beforehand.
    if (executor.trusted === true && executor.locality === "remote" && typeof executor.execute === "function") {
      executors[alias] = executor;
    }
  }
  return Object.freeze(executors);
}
