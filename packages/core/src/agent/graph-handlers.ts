import type { GraphExecutionAdapter, GraphFunctionHandler } from "./graph-engineering.js";
import type { PluginContributions } from "../plugins/index.js";

/** Deterministic handlers shared by the CLI and Server Graph adapters. */
export const BUILTIN_GRAPH_HANDLERS: Readonly<Record<string, GraphFunctionHandler>> = Object.freeze({
  noop: () => ({ output: null }),
  collect: ({ dependencies }) => ({
    output: Object.fromEntries([...dependencies].map(([id, result]) => [id, result.output])),
  }),
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
