import { isRecord } from "../util/guards.js";
import type { GraphFunctionContext, GraphFunctionHandler } from "./graph-execution-contract.js";
import { GraphNodeNonRetryableError } from "./graph-execution-errors.js";

/**
 * Declarative Graph handlers for hosts that only load a definition — the CLI,
 * the Server, and plugin aliases — so `function` / `map` / `compensation` nodes
 * can express deterministic work without embedding SeekForge as a library.
 *
 * These handlers widen no attack surface. A definition still selects a handler
 * by name from this fixed catalogue: it never carries code, never names a
 * command or path, and never reaches outside the graph. Every operand is either
 * the node's own declared `inputs` (already resolved from a *declared
 * dependency* through a JSON Pointer and checked against its declared schema by
 * `graphInputs`) or the map item the runtime supplies. Every handler is a pure
 * function of those operands, so retries are idempotent and a resumed
 * checkpoint recomputes the same output.
 *
 * Operand convention, chosen because `GraphNode` carries no handler parameters
 * and the contract must not grow a mini expression language:
 * - single-operand handlers (`pick`, `count`, `summarize`) read the map item
 *   when the runtime supplies one, and otherwise the input named `value`;
 * - multi-input handlers (`project`, `merge`, `assert`) read every declared
 *   input in declaration order and reject map items, because they would
 *   otherwise silently ignore the item and emit the same output N times.
 *
 * A declared input that does not resolve is a definition bug, not a transient
 * failure, so it fails the node without retrying instead of leaving `undefined`
 * holes downstream.
 */

/** The primary operand of a single-operand handler outside a map item context. */
const OPERAND_INPUT = "value";

export const DECLARATIVE_GRAPH_HANDLER_IDS = ["pick", "project", "merge", "assert", "count", "summarize"] as const;
export type DeclarativeGraphHandlerId = (typeof DECLARATIVE_GRAPH_HANDLER_IDS)[number];

/**
 * The complete built-in catalogue. It lives in this leaf module so plugin
 * manifest validation can share one source of truth without pulling the plugin
 * loader back into the Graph runtime modules.
 */
export const BUILTIN_GRAPH_HANDLER_IDS = ["noop", "collect", ...DECLARATIVE_GRAPH_HANDLER_IDS] as const;
export type BuiltinGraphHandlerId = (typeof BUILTIN_GRAPH_HANDLER_IDS)[number];

/** Declaration order of the node's `inputs`, as materialized by `graphInputs`. */
function declaredInputs(context: GraphFunctionContext, handlerId: DeclarativeGraphHandlerId): string[] {
  const names = Object.keys(context.inputs);
  if (names.length === 0) {
    throw new GraphNodeNonRetryableError(`Graph handler ${handlerId} requires at least one declared input`);
  }
  return names;
}

function resolvedInput(context: GraphFunctionContext, handlerId: DeclarativeGraphHandlerId, name: string): unknown {
  const value = Object.hasOwn(context.inputs, name) ? context.inputs[name] : undefined;
  if (value === undefined) {
    throw new GraphNodeNonRetryableError(`Graph handler ${handlerId} input ${name} did not resolve to a value`);
  }
  return value;
}

function rejectMapItem(context: GraphFunctionContext, handlerId: DeclarativeGraphHandlerId): void {
  if (context.itemIndex !== undefined) {
    throw new GraphNodeNonRetryableError(`Graph handler ${handlerId} cannot be used as a map item handler`);
  }
}

function operand(context: GraphFunctionContext, handlerId: DeclarativeGraphHandlerId): unknown {
  if (context.itemIndex !== undefined) {
    if (context.item === undefined) {
      throw new GraphNodeNonRetryableError(`Graph handler ${handlerId} received an empty map item`);
    }
    return context.item;
  }
  if (!Object.hasOwn(context.inputs, OPERAND_INPUT)) {
    throw new GraphNodeNonRetryableError(`Graph handler ${handlerId} requires an input named ${OPERAND_INPUT}`);
  }
  return resolvedInput(context, handlerId, OPERAND_INPUT);
}

export const DECLARATIVE_GRAPH_HANDLERS: Readonly<Record<DeclarativeGraphHandlerId, GraphFunctionHandler>> =
  Object.freeze({
    /** Forwards one declared binding (or the map item) as this node's output. */
    pick: (context) => ({ output: operand(context, "pick") }),

    /** Emits every declared binding as one object keyed by input name. */
    project: (context) => {
      rejectMapItem(context, "project");
      const output = Object.create(null) as Record<string, unknown>;
      for (const name of declaredInputs(context, "project")) output[name] = resolvedInput(context, "project", name);
      return { output };
    },

    /** Shallow-merges declared object bindings in declaration order; later inputs win. */
    merge: (context) => {
      rejectMapItem(context, "merge");
      const output = Object.create(null) as Record<string, unknown>;
      for (const name of declaredInputs(context, "merge")) {
        const value = resolvedInput(context, "merge", name);
        if (!isRecord(value)) {
          throw new GraphNodeNonRetryableError(`Graph handler merge input ${name} must resolve to an object`);
        }
        // Upstream output is untrusted data; never let one of its keys reach a prototype.
        for (const key of Object.keys(value)) if (key !== "__proto__") output[key] = value[key];
      }
      return { output };
    },

    /**
     * Fails the node unless every declared binding resolves and satisfies its
     * declared schema — the schema check itself already ran in `graphInputs`.
     * Emits only the checked names so a judgment node stays cheap inside the
     * persisted output budget.
     */
    assert: (context) => {
      rejectMapItem(context, "assert");
      const names = declaredInputs(context, "assert");
      for (const name of names) resolvedInput(context, "assert", name);
      return { output: { asserted: names } };
    },

    /** Counts array elements or own object keys, so `outputSchema` can gate the size. */
    count: (context) => {
      const value = operand(context, "count");
      if (Array.isArray(value)) return { output: { count: value.length } };
      if (isRecord(value)) return { output: { count: Object.keys(value).length } };
      throw new GraphNodeNonRetryableError("Graph handler count requires an array or object operand");
    },

    /** Bounded statistics over an array, usually the item results of a map node. */
    summarize: (context) => {
      const value = operand(context, "summarize");
      if (!Array.isArray(value)) {
        throw new GraphNodeNonRetryableError("Graph handler summarize requires an array operand");
      }
      const byType = { array: 0, boolean: 0, null: 0, number: 0, object: 0, string: 0 };
      let truthy = 0;
      for (const item of value) {
        const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
        if (!Object.hasOwn(byType, type)) {
          throw new GraphNodeNonRetryableError(`Graph handler summarize cannot summarize a ${type} item`);
        }
        byType[type as keyof typeof byType] += 1;
        if (item) truthy += 1;
      }
      return { output: { count: value.length, truthy, falsy: value.length - truthy, byType } };
    },
  } satisfies Record<DeclarativeGraphHandlerId, GraphFunctionHandler>);
