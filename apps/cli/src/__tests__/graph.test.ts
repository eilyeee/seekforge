import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { recordGraphSchedulingObservation, runEngineeringGraph, type AgentCoreDeps } from "@seekforge/core";
import {
  graphCompareCommand,
  graphControlCommand,
  graphEvidenceCommand,
  formatGraphEvent,
  graphIntelligenceCommand,
  graphSignalCommand,
  graphTemplateCompareCommand,
  graphTemplateDeprecateCommand,
  graphTemplateListCommand,
  graphTemplateRegisterCommand,
  graphTemplateShowCommand,
  readEngineeringGraphFile,
} from "../commands/graph.js";
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
        "expansion-plan",
        "migrate",
        "simulate",
        "explain",
      ]),
    );
  });

  it("exposes every durable control the REST surface accepts", () => {
    const program = new Command();
    registerGraphCommands(
      program,
      (value, previous) => [...previous, value],
      () => undefined,
    );
    const graph = program.commands.find((command) => command.name() === "graph");
    expect(graph?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "pause",
        "continue",
        "steer",
        "cancel-node",
        "reprioritize",
        "signal",
        "evidence",
        "compare",
        "template",
      ]),
    );
    const template = graph?.commands.find((command) => command.name() === "template");
    expect(template?.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining(["list", "show", "register", "compare", "deprecate"]),
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

describe("Engineering Graph CLI control plane", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  /** A pure `wait` Graph reaches a durable paused checkpoint without a provider. */
  async function waitingGraph(prefix: string): Promise<{ workspace: string; graphId: string }> {
    const workspace = mkdtempSync(join(tmpdir(), prefix));
    workspaces.push(workspace);
    const graphId = "release";
    await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId,
        nodes: [{ id: "external", kind: "wait" as const, waitFor: { signal: "approved" } }],
      },
      { workspace },
    );
    vi.spyOn(process, "cwd").mockReturnValue(workspace);
    return { workspace, graphId };
  }

  it("delivers only a signal the definition declares, and points at resume", async () => {
    const { graphId } = await waitingGraph("seekforge-graph-cli-signal-");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await graphSignalCommand(graphId, "undeclared");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("declared wait node"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    await graphSignalCommand(graphId, "approved", '{"build":42}');
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Queued signal approved"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("graph resume"));
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects a malformed signal payload before touching the mailbox", async () => {
    const { graphId } = await waitingGraph("seekforge-graph-cli-payload-");
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await graphSignalCommand(graphId, "approved", "{not json");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("valid JSON"));
    expect(process.exitCode).toBe(1);
  });

  it("refuses control commands unless a run owns the Graph", async () => {
    const { graphId } = await waitingGraph("seekforge-graph-cli-control-");
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await graphControlCommand(graphId, { operation: "pause" });
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not running"));
    expect(process.exitCode).toBe(1);
  });

  it("exports evidence and detects a tampered report", async () => {
    const { workspace, graphId } = await waitingGraph("seekforge-graph-cli-evidence-");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    graphEvidenceCommand(graphId);
    const report = JSON.parse(String(log.mock.calls[0]?.[0])) as { integrity: unknown; status: string };
    expect(report).toMatchObject({ graphId, status: "paused" });
    expect(report.integrity).toBeDefined();

    writeFileSync(join(workspace, "evidence.json"), JSON.stringify(report));
    graphEvidenceCommand(undefined, { verify: "evidence.json" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("intact"));
    expect(process.exitCode).toBeUndefined();

    writeFileSync(join(workspace, "tampered.json"), JSON.stringify({ ...report, status: "passed" }));
    graphEvidenceCommand(undefined, { verify: "tampered.json" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("tampered"));
    expect(process.exitCode).toBe(1);
  });

  it("requires an archived baseline before comparing runs", async () => {
    const { graphId } = await waitingGraph("seekforge-graph-cli-compare-");
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    graphCompareCommand(graphId);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("baseline not found"));
    expect(process.exitCode).toBe(1);
  });

  it("prints the event message rather than the bare type", () => {
    // graph.warning carries its entire content in `message`; a printer that
    // shows only the type tells a watching operator that something happened
    // and nothing about what.
    expect(
      formatGraphEvent({
        sequence: 42,
        type: "graph.warning",
        timestamp: "2026-08-11T00:00:00.000Z",
        message: "Graph signal cleanup failed: EACCES",
      }),
    ).toBe("[42] graph.warning — Graph signal cleanup failed: EACCES");
    expect(
      formatGraphEvent({
        sequence: 43,
        type: "node.completed",
        timestamp: "2026-08-11T00:00:01.000Z",
        nodeId: "verify",
        status: "passed",
      }),
    ).toBe("[43] node.completed verify passed");
  });

  it("completes the template registry lifecycle from the CLI", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-cli-template-"));
    workspaces.push(workspace);
    vi.spyOn(process, "cwd").mockReturnValue(workspace);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const template = (version: string, extra: Record<string, unknown> = {}) => ({
      schemaVersion: 2,
      kind: "engineering-graph-template",
      templateId: "package-release",
      version,
      parameters: { pkg: { type: "string", default: "core" }, ...(extra.parameters as object) },
      definition: { graphId: "release-${{pkg}}", nodes: [{ id: "review", kind: "gate" }] },
    });
    writeFileSync(join(workspace, "v1.json"), JSON.stringify(template("1.0.0")));
    graphTemplateRegisterCommand("v1.json");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("package-release@1.0.0"));

    graphTemplateListCommand();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("package-release@1.0.0"));
    graphTemplateShowCommand("package-release", "1.0.0");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ templateId: "package-release" });

    // A newly required parameter is breaking, and the CLI must fail on it.
    writeFileSync(
      join(workspace, "v2.json"),
      JSON.stringify(template("2.0.0", { parameters: { extra: { type: "string" } } })),
    );
    graphTemplateCompareCommand("package-release", "1.0.0", "v2.json");
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ classification: "breaking" });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;

    graphTemplateDeprecateCommand("package-release", "1.0.0");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Deprecated Graph template"));
    graphTemplateListCommand();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("deprecated="));

    graphTemplateShowCommand("package-release", "9.9.9");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("not found"));
    expect(process.exitCode).toBe(1);
  });
});
