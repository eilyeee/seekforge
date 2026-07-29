import { describe, expect, it } from "vitest";
import { buildEngineeringGraphArtifactCatalog } from "../../src/agent/graph-artifact-catalog.js";
import { parseEngineeringGraphDefinition } from "../../src/agent/graph-contract.js";
import { planEngineeringGraphMigration } from "../../src/agent/graph-migration.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";

describe("Engineering Graph expansion policies", () => {
  it("plans migration invalidation through descendants", () => {
    const before = parseEngineeringGraphDefinition({
      graphId: "migrate",
      nodes: [
        { id: "source", kind: "function", handler: "source" },
        { id: "consume", kind: "function", handler: "consume", dependsOn: ["source"] },
      ],
    });
    const after = parseEngineeringGraphDefinition({
      graphId: "migrate",
      nodes: [
        { id: "source", kind: "function", handler: "source-v2" },
        { id: "consume", kind: "function", handler: "consume", dependsOn: ["source"] },
        { id: "report", kind: "function", handler: "report", dependsOn: ["consume"] },
      ],
    });
    expect(planEngineeringGraphMigration(before, after)).toEqual({
      graphId: "migrate",
      added: ["report"],
      removed: [],
      changed: ["source"],
      preserved: [],
      invalidated: ["consume", "report", "source"],
    });
  });

  it("does not treat object key order as a Graph migration", () => {
    const before = parseEngineeringGraphDefinition({
      graphId: "stable-order",
      nodes: [{ id: "build", kind: "function", handler: "build" }],
    });
    const node = before.nodes[0]!;
    const after = {
      ...before,
      nodes: [{ handler: node.handler, kind: node.kind, id: node.id }],
    } as typeof before;
    expect(planEngineeringGraphMigration(before, after)).toMatchObject({
      changed: [],
      invalidated: [],
      preserved: ["build"],
    });
  });

  it("builds deterministic content-addressed artifact lineage", () => {
    const definition = parseEngineeringGraphDefinition({
      graphId: "catalog",
      nodes: [
        { id: "build", kind: "function", handler: "build" },
        { id: "publish", kind: "function", handler: "publish", dependsOn: ["build"] },
      ],
    });
    const state = {
      definition,
      results: [
        {
          id: "build",
          kind: "function",
          status: "passed",
          attempts: 1,
          costUsd: 0,
          tokensUsed: 0,
          artifacts: [
            { name: "bundle", path: "dist/app.js", sha256: "a".repeat(64) },
            { name: "manifest", path: "dist/manifest.json" },
          ],
        },
      ],
    } as EngineeringGraphState;
    expect(buildEngineeringGraphArtifactCatalog(state)).toEqual([
      expect.objectContaining({
        key: "path:build:dist/manifest.json",
        producerNodeId: "build",
        consumers: ["publish"],
      }),
      expect.objectContaining({
        key: `sha256:${"a".repeat(64)}`,
        producerNodeId: "build",
        consumers: ["publish"],
      }),
    ]);
  });
});
