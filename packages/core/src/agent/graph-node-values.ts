import { isRecord } from "../util/guards.js";
import type { GraphInputBinding, GraphNode, GraphValueSchema } from "./graph-contract.js";
import { GraphNodeNonRetryableError } from "./graph-execution-errors.js";
import { MAX_GRAPH_OUTPUT_BYTES, MAX_GRAPH_OUTPUT_TOTAL_BYTES, type GraphNodeResult } from "./graph-state.js";

/**
 * Value plumbing between Graph nodes: what a node may emit, what a downstream
 * node may read, and how both stay inside the persisted output budget. Every
 * rule here is a boundary — untrusted handler output crosses it — so it is
 * owned in one place rather than inlined into the executor.
 */

/** Caps a single node output, replacing anything unserializable with a marker. */
export function boundedOutput(value: unknown): unknown {
  if (value === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: "[non-serializable Graph node output]" };
  }
  if (serialized === undefined) return { truncated: true, preview: "[unsupported Graph node output]" };
  if (Buffer.byteLength(serialized) > MAX_GRAPH_OUTPUT_BYTES) {
    return { truncated: true, preview: serialized.slice(0, 1024) };
  }
  return JSON.parse(serialized) as unknown;
}

/** Keeps the whole run inside the total output budget, degrading to a marker. */
export function fitOutputBudget(value: unknown, results: ReadonlyMap<string, GraphNodeResult>): unknown {
  if (value === undefined) return undefined;
  const used = [...results.values()].reduce(
    (total, result) => total + (result.output === undefined ? 0 : Buffer.byteLength(JSON.stringify(result.output))),
    0,
  );
  const serialized = JSON.stringify(value);
  if (used + Buffer.byteLength(serialized) <= MAX_GRAPH_OUTPUT_TOTAL_BYTES) return value;
  const marker = { truncated: true };
  return used + Buffer.byteLength(JSON.stringify(marker)) <= MAX_GRAPH_OUTPUT_TOTAL_BYTES ? marker : undefined;
}

/** Resolves one JSON-pointer binding against completed results, never through the prototype chain. */
export function bindingValue(binding: GraphInputBinding, completed: ReadonlyMap<string, GraphNodeResult>): unknown {
  let value = completed.get(binding.nodeId)?.output;
  if (!binding.pointer) return value;
  for (const encoded of binding.pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (key === "__proto__" || key === "prototype" || key === "constructor" || value === null) return undefined;
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) return undefined;
      value = value[Number(key)];
    } else if (isRecord(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      value = descriptor.value;
    } else return undefined;
  }
  return value;
}

/** Builds a node's declared inputs, validating each against its schema first. */
export function graphInputs(node: GraphNode, completed: ReadonlyMap<string, GraphNodeResult>): Record<string, unknown> {
  const inputs = Object.create(null) as Record<string, unknown>;
  for (const [name, binding] of Object.entries(node.inputs ?? {})) {
    const value = bindingValue(binding, completed);
    assertGraphValue(value, binding.schema, `Graph node ${node.id} input ${name}`);
    inputs[name] = value;
  }
  return inputs;
}

/** Schema violations are contract bugs, so they raise non-retryable failures. */
export function assertGraphValue(value: unknown, schema: GraphValueSchema | undefined, label: string, depth = 0): void {
  if (!schema) return;
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (actual !== schema.type) throw new GraphNodeNonRetryableError(`${label} must be ${schema.type}`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    throw new GraphNodeNonRetryableError(`${label} is outside its enum`);
  }
  if (schema.type === "object") {
    if (!isRecord(value)) throw new GraphNodeNonRetryableError(`${label} must be an object`);
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) throw new GraphNodeNonRetryableError(`${label} is missing ${name}`);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties ?? {}, name)) {
          throw new GraphNodeNonRetryableError(`${label} contains unsupported property ${name}`);
        }
      }
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, name)) assertGraphValue(value[name], child, `${label}.${name}`, depth + 1);
    }
  }
  if (schema.type === "array") {
    const items = value as unknown[];
    if (schema.minItems !== undefined && items.length < schema.minItems)
      throw new GraphNodeNonRetryableError(`${label} has fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && items.length > schema.maxItems)
      throw new GraphNodeNonRetryableError(`${label} has more than ${schema.maxItems} items`);
    if (schema.items) {
      for (const [index, item] of items.entries())
        assertGraphValue(item, schema.items, `${label}[${index}]`, depth + 1);
    }
  }
  if (depth > 8) throw new GraphNodeNonRetryableError(`${label} schema is too deeply nested`);
}
