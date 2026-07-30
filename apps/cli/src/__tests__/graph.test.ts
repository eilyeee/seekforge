import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { recordGraphSchedulingObservation } from "@seekforge/core";
import { graphIntelligenceCommand, readEngineeringGraphFile } from "../commands/graph.js";
import { registerGraphCommands } from "../register-graph.js";

describe("Engineering Graph CLI input", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("registers diagnostics, intelligence, migration, simulation, and explanation as first-class Graph commands", () => {
    const program = new Command();
    registerGraphCommands(
      program,
      (value, previous) => [...previous, value],
      () => undefined,
    );
    const graph = program.commands.find((command) => command.name() === "graph");
    expect(graph?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "diagnose",
        "health",
        "intelligence",
        "migration-plan",
        "migrate",
        "simulate",
        "explain",
      ]),
    );
  });

  it("reports scheduling intelligence without node output", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-cli-intelligence-"));
    workspaces.push(workspace);
    recordGraphSchedulingObservation(workspace, {
      graphId: "release",
      nodeId: "verify",
      fingerprint: "a".repeat(64),
      durationMs: 20,
      passed: false,
      recordedAt: new Date().toISOString(),
    });
    vi.spyOn(process, "cwd").mockReturnValue(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    graphIntelligenceCommand("release");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      entries: [expect.objectContaining({ graphId: "release", nodeId: "verify", failures: 1 })],
      findings: [],
    });
  });
});
