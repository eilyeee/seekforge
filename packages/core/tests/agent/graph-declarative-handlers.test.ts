import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_GRAPH_HANDLER_IDS,
  DECLARATIVE_GRAPH_HANDLER_IDS,
  DECLARATIVE_GRAPH_HANDLERS,
  type DeclarativeGraphHandlerId,
} from "../../src/agent/graph-declarative-handlers.js";
import { BUILTIN_GRAPH_HANDLERS, graphHandlersWithPlugins } from "../../src/agent/graph-handlers.js";
import type { GraphNode } from "../../src/agent/graph-contract.js";
import type { GraphFunctionContext, GraphFunctionResult } from "../../src/agent/graph-execution-contract.js";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

const deps = {} as AgentCoreDeps;

function context(input: {
  inputs?: Record<string, unknown>;
  item?: unknown;
  itemIndex?: number;
  node?: Partial<GraphNode>;
}): GraphFunctionContext {
  // Mirrors graphInputs: a null-prototype record whose key order is the
  // declaration order of the node's inputs.
  const inputs = Object.assign(Object.create(null) as Record<string, unknown>, input.inputs ?? {});
  return {
    node: { id: "node", kind: "function", handler: "noop", ...input.node },
    workspace: "/workspace",
    dependencies: new Map(),
    inputs,
    idempotencyKey: "key",
    ...(input.itemIndex === undefined ? {} : { item: input.item, itemIndex: input.itemIndex }),
    signal: new AbortController().signal,
  };
}

function run(id: DeclarativeGraphHandlerId, ctx: GraphFunctionContext): GraphFunctionResult {
  return DECLARATIVE_GRAPH_HANDLERS[id](ctx) as GraphFunctionResult;
}

describe("declarative Graph handlers", () => {
  it("registers every declared id exactly once in the built-in catalogue", () => {
    expect(Object.keys(DECLARATIVE_GRAPH_HANDLERS).sort()).toEqual([...DECLARATIVE_GRAPH_HANDLER_IDS].sort());
    expect(Object.keys(BUILTIN_GRAPH_HANDLERS).sort()).toEqual([...BUILTIN_GRAPH_HANDLER_IDS].sort());
    expect(new Set(BUILTIN_GRAPH_HANDLER_IDS).size).toBe(BUILTIN_GRAPH_HANDLER_IDS.length);
    for (const id of BUILTIN_GRAPH_HANDLER_IDS) expect(BUILTIN_GRAPH_HANDLERS[id]).toBeTypeOf("function");
  });

  it("lets plugin manifests alias a declarative built-in without carrying code", () => {
    const handlers = graphHandlersWithPlugins({ graphHandlers: { demo__take: "pick", demo__stats: "summarize" } });
    expect(handlers["demo__take"]).toBe(BUILTIN_GRAPH_HANDLERS.pick);
    expect(handlers["demo__stats"]).toBe(BUILTIN_GRAPH_HANDLERS.summarize);
    // An unknown target is dropped instead of becoming an executable hook.
    expect(graphHandlersWithPlugins({ graphHandlers: { evil: "toString" } as never }).evil).toBeUndefined();
  });

  it("pick forwards the declared value input and the map item", () => {
    expect(run("pick", context({ inputs: { value: { ok: true } } })).output).toEqual({ ok: true });
    expect(run("pick", context({ item: "item", itemIndex: 0 })).output).toBe("item");
    expect(() => run("pick", context({ inputs: { other: 1 } }))).toThrow(/requires an input named value/);
    expect(() => run("pick", context({ inputs: { value: undefined } }))).toThrow(/did not resolve/);
    expect(() => run("pick", context({ itemIndex: 1 }))).toThrow(/empty map item/);
  });

  it("project emits every declared binding keyed by input name", () => {
    const result = run("project", context({ inputs: { left: 1, right: "two" } }));
    expect(JSON.parse(JSON.stringify(result.output))).toEqual({ left: 1, right: "two" });
    expect(() => run("project", context({}))).toThrow(/at least one declared input/);
    expect(() => run("project", context({ inputs: { left: undefined } }))).toThrow(/did not resolve/);
    expect(() => run("project", context({ inputs: { left: 1 }, item: 1, itemIndex: 0 }))).toThrow(/map item handler/);
  });

  it("merge combines object bindings in declaration order without touching prototypes", () => {
    const merged = run("merge", context({ inputs: { base: { a: 1, b: 1 }, over: { b: 2, c: 3 } } })).output;
    expect(JSON.parse(JSON.stringify(merged))).toEqual({ a: 1, b: 2, c: 3 });
    const polluted = run("merge", context({ inputs: { a: JSON.parse('{"__proto__":{"polluted":true},"kept":1}') } }));
    expect(JSON.parse(JSON.stringify(polluted.output))).toEqual({ kept: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(() => run("merge", context({ inputs: { a: [1] } }))).toThrow(/must resolve to an object/);
    expect(() => run("merge", context({ inputs: { a: {} }, item: 1, itemIndex: 0 }))).toThrow(/map item handler/);
  });

  it("assert requires every declared binding to resolve and reports the checked names", () => {
    expect(run("assert", context({ inputs: { first: 0, second: false } })).output).toEqual({
      asserted: ["first", "second"],
    });
    expect(() => run("assert", context({ inputs: { first: undefined } }))).toThrow(/did not resolve/);
    expect(() => run("assert", context({}))).toThrow(/at least one declared input/);
    expect(() => run("assert", context({ inputs: { a: 1 }, item: 1, itemIndex: 0 }))).toThrow(/map item handler/);
  });

  it("count sizes arrays and objects and refuses anything else", () => {
    expect(run("count", context({ inputs: { value: [1, 2, 3] } })).output).toEqual({ count: 3 });
    expect(run("count", context({ inputs: { value: { a: 1, b: 2 } } })).output).toEqual({ count: 2 });
    expect(run("count", context({ item: [1], itemIndex: 2 })).output).toEqual({ count: 1 });
    expect(() => run("count", context({ inputs: { value: "abc" } }))).toThrow(/array or object operand/);
  });

  it("summarize reports bounded, deterministic statistics for an array", () => {
    const output = run("summarize", context({ inputs: { value: [1, 0, "a", "", true, false, null, {}, []] } })).output;
    expect(output).toEqual({
      count: 9,
      truthy: 5,
      falsy: 4,
      byType: { array: 1, boolean: 2, null: 1, number: 2, object: 1, string: 2 },
    });
    expect(() => run("summarize", context({ inputs: { value: { a: 1 } } }))).toThrow(/array operand/);
    expect(() => run("summarize", context({ inputs: { value: [undefined] } }))).toThrow(/cannot summarize/);
  });
});

describe("declarative Graph handlers inside a run", () => {
  const workspaces: string[] = [];
  const workspace = (): string => {
    const created = mkdtempSync(join(tmpdir(), "seekforge-declarative-"));
    workspaces.push(created);
    return created;
  };
  afterEach(() => {
    while (workspaces.length) rmSync(workspaces.pop()!, { recursive: true, force: true });
  });

  // Only the seed stands in for an Agent/Loop/remote node; everything after it
  // is expressible from a definition alone.
  const handlers = { ...BUILTIN_GRAPH_HANDLERS, seed: () => ({ output: { items: [1, 2, 3], meta: { run: "a" } } }) };

  it("projects, maps, counts and asserts without any user-supplied code", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "declarative-pipeline",
        nodes: [
          { id: "seed", kind: "function", handler: "seed" },
          {
            id: "items",
            kind: "function",
            handler: "pick",
            dependsOn: ["seed"],
            inputs: { value: { nodeId: "seed", pointer: "/items", schema: { type: "array", minItems: 1 } } },
          },
          {
            id: "doubled",
            kind: "map",
            handler: "pick",
            dependsOn: ["items"],
            source: { nodeId: "items", schema: { type: "array", maxItems: 8, items: { type: "number" } } },
            maxItems: 8,
          },
          {
            id: "size",
            kind: "function",
            handler: "count",
            dependsOn: ["doubled"],
            inputs: { value: { nodeId: "doubled" } },
            outputSchema: { type: "object", properties: { count: { type: "number", enum: [3] } }, required: ["count"] },
          },
          {
            id: "stats",
            kind: "function",
            handler: "summarize",
            dependsOn: ["doubled"],
            inputs: { value: { nodeId: "doubled" } },
            outputSchema: { type: "object", properties: { falsy: { type: "number", enum: [0] } } },
          },
          {
            id: "report",
            kind: "function",
            handler: "merge",
            dependsOn: ["seed", "size"],
            inputs: { meta: { nodeId: "seed", pointer: "/meta" }, size: { nodeId: "size" } },
          },
          {
            id: "gatekeeper",
            kind: "function",
            handler: "assert",
            dependsOn: ["report"],
            inputs: {
              run: { nodeId: "report", pointer: "/run", schema: { type: "string", enum: ["a"] } },
              count: { nodeId: "report", pointer: "/count", schema: { type: "number", enum: [3] } },
            },
          },
        ],
      },
      { workspace: root, persist: false, handlers },
    );
    expect(state.status).toBe("passed");
    const output = (id: string): unknown => state.results.find((result) => result.id === id)?.output;
    expect(output("items")).toEqual([1, 2, 3]);
    expect(output("doubled")).toEqual([1, 2, 3]);
    expect(output("size")).toEqual({ count: 3 });
    expect(output("stats")).toMatchObject({ count: 3, falsy: 0 });
    expect(output("report")).toEqual({ run: "a", count: 3 });
    expect(output("gatekeeper")).toEqual({ asserted: ["run", "count"] });
  });

  it("fails the node, without retrying, when an asserted binding violates its schema", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "declarative-assert",
        failurePolicy: "continue",
        nodes: [
          { id: "seed", kind: "function", handler: "seed" },
          {
            id: "gatekeeper",
            kind: "function",
            handler: "assert",
            dependsOn: ["seed"],
            maxRetries: 2,
            inputs: { run: { nodeId: "seed", pointer: "/meta/run", schema: { type: "string", enum: ["b"] } } },
          },
          {
            id: "cleanup",
            kind: "compensation",
            handler: "collect",
            dependsOn: ["seed"],
            compensates: ["seed"],
          },
        ],
      },
      { workspace: root, persist: false, handlers },
    );
    expect(state.status).toBe("failed");
    const gatekeeper = state.results.find((result) => result.id === "gatekeeper")!;
    expect(gatekeeper.status).toBe("failed");
    expect(gatekeeper.attempts).toBe(1);
    expect(gatekeeper.error).toMatch(/outside its enum/);
    expect(state.results.find((result) => result.id === "cleanup")?.status).toBe("passed");
  });

  it("fails a missing pointer instead of feeding undefined downstream", async () => {
    const root = workspace();
    const state = await runEngineeringGraph(
      deps,
      {
        graphId: "declarative-missing",
        nodes: [
          { id: "seed", kind: "function", handler: "seed" },
          {
            id: "take",
            kind: "function",
            handler: "pick",
            dependsOn: ["seed"],
            inputs: { value: { nodeId: "seed", pointer: "/absent" } },
          },
        ],
      },
      { workspace: root, persist: false, handlers },
    );
    expect(state.status).toBe("failed");
    expect(state.results.find((result) => result.id === "take")?.error).toMatch(/did not resolve/);
  });
});
