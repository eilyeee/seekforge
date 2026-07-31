import { describe, expect, it } from "vitest";
import { appendGraphNode, buildVisualGraph } from "./graph-visual";

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
