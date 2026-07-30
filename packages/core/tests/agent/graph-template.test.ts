import { describe, expect, it } from "vitest";
import { planEngineeringGraph } from "../../src/agent/graph-plan.js";
import { materializeEngineeringGraph, parseEngineeringGraphTemplate } from "../../src/agent/graph-template.js";
import {
  listEngineeringGraphTemplates,
  compareEngineeringGraphTemplates,
  deprecateEngineeringGraphTemplate,
  registerEngineeringGraphTemplate,
  resolveEngineeringGraphTemplate,
} from "../../src/agent/graph-template-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("classifies template compatibility and persists explicit deprecation", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-template-"));
    try {
      const before = { ...template, schemaVersion: 2, version: "1.0.0" };
      const compatible = {
        ...before,
        version: "1.1.0",
        parameters: { ...before.parameters, optional: { type: "string", default: "ok" } },
      };
      const breaking = {
        ...before,
        version: "2.0.0",
        parameters: { retries: before.parameters.retries, enabled: before.parameters.enabled },
      };
      expect(compareEngineeringGraphTemplates(before, compatible).classification).toBe("compatible");
      expect(compareEngineeringGraphTemplates(before, breaking)).toMatchObject({
        classification: "breaking",
        reasons: ["removed parameter: package"],
      });
      expect(compareEngineeringGraphTemplates(before, { ...compatible, version: "1.0.0" })).toMatchObject({
        classification: "breaking",
        reasons: ["version does not advance"],
      });
      expect(
        compareEngineeringGraphTemplates({ ...before, version: "1.0.0" }, { ...compatible, version: "1.0.0-beta.1" }),
      ).toMatchObject({ classification: "breaking", reasons: ["version does not advance"] });
      registerEngineeringGraphTemplate(workspace, before);
      const deprecated = deprecateEngineeringGraphTemplate(workspace, "release-template", "1.0.0");
      expect(deprecated.deprecatedAt).toBeDefined();
      expect(deprecateEngineeringGraphTemplate(workspace, "release-template", "1.0.0")).toEqual(deprecated);
      registerEngineeringGraphTemplate(workspace, before);
      expect(listEngineeringGraphTemplates(workspace)[0]?.deprecatedAt).toBe(deprecated.deprecatedAt);
      expect(listEngineeringGraphTemplates(workspace)[0]?.deprecatedAt).toBeDefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
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
    expect(() => parseEngineeringGraphTemplate({ ...template, schemaVersion: 3 })).toThrow(/schemaVersion 1 or 2/);
  });

  it("registers and resolves exact semantic versions", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-template-"));
    try {
      const versioned = {
        ...template,
        schemaVersion: 2,
        version: "2.1.0",
        interface: { outputSchema: { type: "object", additionalProperties: false } },
      };
      registerEngineeringGraphTemplate(workspace, versioned);
      expect(listEngineeringGraphTemplates(workspace)).toHaveLength(1);
      expect(resolveEngineeringGraphTemplate(workspace, "release-template", "2.1.0")?.version).toBe("2.1.0");
      expect(() =>
        parseEngineeringGraphTemplate({ ...versioned, interface: { outputSchema: { type: "unknown" } } }),
      ).toThrow(/outputSchema/);
      expect(() => resolveEngineeringGraphTemplate(workspace, "release-template", "latest")).toThrow(/invalid/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
