import { describe, expect, it } from "vitest";
import { planEngineeringGraph } from "../../src/agent/graph-plan.js";
import { materializeEngineeringGraph, parseEngineeringGraphTemplate } from "../../src/agent/graph-template.js";

const template = {
  schemaVersion: 1,
  kind: "engineering-graph-template",
  templateId: "release-template",
  parameters: {
    package: { type: "string" },
    retries: { type: "number", default: 2 },
    enabled: { type: "boolean", default: true },
  },
  definition: {
    graphId: "release-${{package}}",
    managedWorktrees: true,
    fanIn: { verifyCommand: "pnpm --filter ${{package}} test", maxIterations: "${{retries}}" },
    nodes: [
      { id: "build", kind: "function", handler: "noop" },
      {
        id: "ship",
        kind: "function",
        handler: "noop",
        dependsOn: ["build"],
        condition: { nodeId: "build", status: "passed" },
      },
    ],
    metadataIgnoredByParser: "${{enabled}}",
  },
};

describe("Engineering Graph templates and plans", () => {
  it("materializes typed exact placeholders and string interpolation", () => {
    const definition = materializeEngineeringGraph(template, { package: "core" });
    expect(definition.graphId).toBe("release-core");
    expect(definition.fanIn).toEqual({ verifyCommand: "pnpm --filter core test", maxIterations: 2 });
    const plan = planEngineeringGraph(definition);
    expect(plan.waves).toEqual([["build"], ["ship"]]);
    expect(plan.nodes[0]?.managedBranch).toMatch(/^seekforge\//);
    expect(plan.fanInBranch).toMatch(/^seekforge\//);
  });

  it("rejects unknown, missing, mistyped, unresolved, sparse, and future-version input", () => {
    expect(() => materializeEngineeringGraph(template)).toThrow(/Missing.*package/);
    expect(() => materializeEngineeringGraph(template, { package: 1 })).toThrow(/must be string/);
    expect(() => materializeEngineeringGraph(template, { package: "core", extra: true })).toThrow(/Unknown/);
    expect(() =>
      materializeEngineeringGraph(
        { ...template, definition: { graphId: "${{unknown}}", nodes: [{ id: "x", kind: "gate" }] } },
        { package: "core" },
      ),
    ).toThrow(/Unknown.*placeholder/);
    const sparse = [template.definition];
    sparse.length = 2;
    expect(() =>
      materializeEngineeringGraph({ ...template, definition: { graphId: "x", nodes: sparse } }, { package: "core" }),
    ).toThrow(/nodes/);
    expect(() => parseEngineeringGraphTemplate({ ...template, schemaVersion: 2 })).toThrow(/schemaVersion 1/);
  });
});
