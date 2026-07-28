import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEngineeringGraphFile } from "../commands/graph.js";

describe("Engineering Graph CLI input", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("parses before runtime setup and rejects malformed files", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-cli-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "graph.json"),
      JSON.stringify({ graphId: "cli", nodes: [{ id: "noop", kind: "function", handler: "noop" }] }),
    );
    expect(readEngineeringGraphFile("graph.json", workspace)).toMatchObject({ graphId: "cli", maxConcurrency: 1 });
    writeFileSync(join(workspace, "bad.json"), "{");
    expect(() => readEngineeringGraphFile("bad.json", workspace)).toThrow(/not valid JSON/);
  });

  it("materializes typed Graph template parameters", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-cli-graph-template-"));
    workspaces.push(workspace);
    writeFileSync(
      join(workspace, "template.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "engineering-graph-template",
        templateId: "cli-template",
        parameters: { retries: { type: "number" } },
        definition: {
          graphId: "cli-template-run",
          nodes: [{ id: "review", kind: "gate", maxRetries: "${{retries}}" }],
        },
      }),
    );
    expect(readEngineeringGraphFile("template.json", workspace, ["retries=2"]).nodes[0]?.maxRetries).toBe(2);
    expect(() => readEngineeringGraphFile("template.json", workspace, ["retries=2", "retries=3"])).toThrow(
      /duplicated/,
    );
  });
});
