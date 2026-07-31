import { describe, expect, it } from "vitest";
import { appendGraphNode, buildVisualGraph, removeGraphNode, setGraphNodeDependencies } from "./graph-visual";

describe("graph visual model", () => {
  it("lays out dependencies in deterministic layers", () => {
    const graph = buildVisualGraph({
      nodes: [
        { id: "b", kind: "agent", dependsOn: ["a"] },
        { id: "a", kind: "function" },
      ],
    });
    expect(graph.nodes.find((node) => node.id === "a")?.x).toBeLessThan(
      graph.nodes.find((node) => node.id === "b")?.x ?? 0,
    );
    expect(graph.edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("edits template nodes without discarding the template envelope", () => {
    const definition = {
      schemaVersion: 2,
      kind: "engineering-graph-template",
      definition: {
        graphId: "template",
        nodes: [
          { id: "a", kind: "function", handler: "noop" },
          { id: "b", kind: "function", handler: "noop" },
        ],
      },
    };
    const changed = setGraphNodeDependencies(definition, "b", ["a"]);
    expect(changed).toMatchObject({
      kind: "engineering-graph-template",
      definition: { nodes: [{ id: "a" }, { id: "b", dependsOn: ["a"] }] },
    });
    expect(() => removeGraphNode(changed, "a")).toThrow(/dependent references/);
    expect(removeGraphNode(changed, "b")).toMatchObject({ definition: { nodes: [{ id: "a" }] } });
  });

  it("does not confuse nested subgraph references with parent dependencies", () => {
    const definition = {
      graphId: "parent",
      nodes: [
        { id: "start", kind: "function", handler: "noop" },
        {
          id: "child",
          kind: "subgraph",
          graph: {
            graphId: "nested",
            nodes: [{ id: "nested", kind: "gate", condition: { nodeId: "inner", status: "passed" } }],
          },
        },
      ],
    };
    expect(() => setGraphNodeDependencies(definition, "child", [])).not.toThrow();
  });

  it("protects router-condition references and rejects ambiguous envelopes", () => {
    const definition = {
      graphId: "router",
      nodes: [
        { id: "source", kind: "function", handler: "noop" },
        {
          id: "route",
          kind: "router",
          dependsOn: ["source"],
          routes: [{ id: "ready", when: { nodeId: "source", status: "passed" } }],
        },
      ],
    };
    expect(() => setGraphNodeDependencies(definition, "route", [])).toThrow(/retain references/);
    expect(() => removeGraphNode(definition, "source")).toThrow(/dependent references/);
    expect(() => appendGraphNode({ definition }, { id: "next", kind: "function", dependsOn: [] })).toThrow(
      /nodes array/,
    );
  });

  it("reports cycles and validates structured additions", () => {
    expect(buildVisualGraph({ nodes: [{ id: "a", kind: "function", dependsOn: ["a"] }] }).warnings[0]).toContain(
      "Cycle",
    );
    expect(
      appendGraphNode({ nodes: [{ id: "a", kind: "function" }] }, { id: "b", kind: "agent", dependsOn: ["a"] }),
    ).toMatchObject({ nodes: [{ id: "a" }, { id: "b", dependsOn: ["a"], task: "Describe the task" }] });
    expect(appendGraphNode({ nodes: [] }, { id: "worker", kind: "agent", dependsOn: [] })).toMatchObject({
      nodes: [{ id: "worker", task: "Describe the task", mode: "edit" }],
    });
    expect(() =>
      appendGraphNode({ nodes: [{ id: "a", kind: "function" }] }, { id: "join", kind: "join", dependsOn: ["a", "a"] }),
    ).toThrow(/unique/);
    expect(() => appendGraphNode({ nodes: [] }, { id: "bad", kind: "remote", dependsOn: [] })).toThrow(/kind/);
    expect(
      buildVisualGraph({
        nodes: [
          { id: "same", kind: "function" },
          { id: "same", kind: "agent" },
        ],
      }),
    ).toMatchObject({ nodes: [{ id: "same", kind: "function" }], warnings: [expect.stringContaining("Duplicate")] });
    expect(buildVisualGraph({ nodes: [{ id: "a", kind: "function", dependsOn: ["a", "a"] }] })).toMatchObject({
      edges: [{ from: "a", to: "a" }],
      warnings: expect.arrayContaining([expect.stringContaining("duplicate dependency")]),
    });
  });
});
