import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parseEngineeringGraphDefinition } from "@seekforge/core";
import { loopDagExportGraphCommand } from "../commands/loop.js";
import { registerLoopCommands } from "../register-loop.js";

const node = { task: "do the work", verifyCommand: "pnpm test" };

describe("seekforge loop-dag export-graph", () => {
  const workspaces: string[] = [];
  const cwd = process.cwd();

  afterEach(() => {
    process.chdir(cwd);
    process.exitCode = undefined;
    vi.restoreAllMocks();
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  function workspaceWith(dag: unknown): string {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-dag-export-"));
    workspaces.push(workspace);
    writeFileSync(join(workspace, "dag.json"), JSON.stringify(dag));
    process.chdir(workspace);
    return workspace;
  }

  it("prints a Graph definition the Graph parser accepts", () => {
    workspaceWith({
      nodes: [
        { id: "build", ...node },
        { id: "publish", ...node, dependsOn: ["build"], requiresApproval: true },
      ],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    loopDagExportGraphCommand("dag.json", { graphId: "exported" });

    expect(process.exitCode).toBeUndefined();
    const printed = stdout.mock.calls.map((call) => String(call[0])).join("");
    const definition = parseEngineeringGraphDefinition(JSON.parse(printed) as unknown);
    expect(definition.graphId).toBe("exported");
    expect(definition.nodes.map((graphNode) => [graphNode.id, graphNode.kind])).toEqual([
      ["build", "loop"],
      ["publish-approval", "gate"],
      ["publish", "loop"],
    ]);
    const warnings = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(warnings).toMatch(/publish -> publish-approval/);
  });

  it("writes the definition atomically when -o is given", () => {
    const workspace = workspaceWith({ nodes: [{ id: "build", ...node }] });
    vi.spyOn(console, "log").mockImplementation(() => {});

    loopDagExportGraphCommand("dag.json", { out: "out/graph.json", graphId: "written" });

    expect(process.exitCode).toBeUndefined();
    const written = JSON.parse(readFileSync(join(workspace, "out", "graph.json"), "utf8")) as { graphId: string };
    expect(written.graphId).toBe("written");
  });

  it("exports declared node outputs now that the Graph loop node carries them", () => {
    workspaceWith({
      nodes: [
        { id: "build", ...node, outputPaths: ["dist/out.json"], budgetWeight: 3, failurePolicy: "stop" },
        { id: "publish", ...node, dependsOn: ["build"], consumeDependencyOutputs: true },
      ],
    });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);

    loopDagExportGraphCommand("dag.json", { graphId: "outputs" });

    expect(process.exitCode).toBeUndefined();
    const printed = stdout.mock.calls.map((call) => String(call[0])).join("");
    const definition = parseEngineeringGraphDefinition(JSON.parse(printed) as unknown);
    expect(definition.nodes[0]).toMatchObject({
      outputPaths: ["dist/out.json"],
      budgetWeight: 3,
      failurePolicy: "stop",
    });
    expect(definition.nodes[1]?.inputs).toEqual({ build: { nodeId: "build" } });
  });

  it("fails with the structured incompatibility instead of exporting a lookalike", () => {
    workspaceWith({
      nodes: [
        {
          id: "build",
          ...node,
          outputPaths: Array.from({ length: 33 }, (_, index) => `dist/out-${index}.json`),
        },
      ],
    });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    loopDagExportGraphCommand("dag.json", {});

    expect(process.exitCode).toBe(1);
    const reported = stderr.mock.calls.map((call) => String(call[0])).join("");
    expect(reported).toMatch(/outputPaths/);
    expect(reported).toMatch(/no equivalent Engineering Graph representation/);
  });

  it("reports a missing or malformed file without throwing", () => {
    workspaceWith({ nodes: [{ id: "build", ...node }] });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    loopDagExportGraphCommand("missing.json", {});
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    writeFileSync(join(process.cwd(), "bad.json"), "{");
    loopDagExportGraphCommand("bad.json", {});
    expect(process.exitCode).toBe(1);
  });

  it("registers export-graph under loop-dag without shadowing the run command", async () => {
    workspaceWith({ nodes: [{ id: "build", ...node }] });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const program = new Command();
    program.exitOverride();
    registerLoopCommands(program, {
      collect: (value: string, previous: string[]) => [...previous, value],
      parsePositiveInt: Number,
      parseNonNegativeInt: Number,
      parsePositiveFloat: Number,
      rootProfile: () => undefined,
    });

    await program.parseAsync(["loop-dag", "export-graph", "dag.json", "--graph-id", "registered"], { from: "user" });

    const printed = stdout.mock.calls.map((call) => String(call[0])).join("");
    expect((JSON.parse(printed) as { graphId: string }).graphId).toBe("registered");
  });
});
