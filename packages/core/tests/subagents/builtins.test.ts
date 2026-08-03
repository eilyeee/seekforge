import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/subagents/builtins.js";
import { loadAgentDefinitions, loadAgentDefinitionsFromDirs, withBuiltinAgents } from "../../src/subagents/load.js";

describe("builtin agents", () => {
  it("ships the specialists a coding run dispatches", () => {
    expect(BUILTIN_AGENTS.map((d) => d.id)).toEqual(["explorer", "reviewer", "planner", "test-writer", "debugger"]);
    for (const def of BUILTIN_AGENTS) {
      expect(def.scope).toBe("builtin");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.own).toBeDefined();
      expect(def.boundary).toBeDefined();
      expect(def.doNotTouch).toBeDefined();
      expect(def.maxTurns).toBeGreaterThan(0);
      expect(def.body!.length).toBeGreaterThan(200); // real procedure, not a stub
      // Every builtin is bounded to named tools: an unrestricted specialist is
      // just the parent agent with a different prompt.
      expect(def.tools?.length).toBeGreaterThan(0);
    }
    const explorer = BUILTIN_AGENTS.find((d) => d.id === "explorer")!;
    expect(explorer.tools).toEqual(["list_files", "read_file", "search_text", "detect_project", "list_scripts"]);
    const reviewer = BUILTIN_AGENTS.find((d) => d.id === "reviewer")!;
    expect(reviewer.tools).toEqual(["list_files", "read_file", "search_text", "git_diff", "git_status"]);
  });

  it("only the specialists that must act are allowed to", () => {
    const modes = Object.fromEntries(BUILTIN_AGENTS.map((d) => [d.id, d.mode]));
    // Investigating and reporting needs nothing but reads.
    expect(modes).toMatchObject({ explorer: "ask", reviewer: "ask", planner: "ask" });
    // Writing a test means writing a file; reproducing a failure means running
    // the thing that fails. Neither is possible in ask mode.
    expect(modes).toMatchObject({ "test-writer": "edit", debugger: "edit" });
  });

  it("the editing specialists cannot reach beyond their job", () => {
    const testWriter = BUILTIN_AGENTS.find((d) => d.id === "test-writer")!;
    // It writes tests and runs them; it does not get a shell.
    expect(testWriter.tools).toContain("apply_patch");
    expect(testWriter.tools).toContain("run_tests");
    expect(testWriter.tools).not.toContain("run_command");
    expect(testWriter.doNotTouch).toContain("implementation");

    const debuggerAgent = BUILTIN_AGENTS.find((d) => d.id === "debugger")!;
    // It runs things to reproduce a failure; it does not edit anything.
    expect(debuggerAgent.tools).toContain("run_command");
    expect(debuggerAgent.tools).not.toContain("write_file");
    expect(debuggerAgent.tools).not.toContain("apply_patch");
  });

  it("planner plans and does not execute", () => {
    const planner = BUILTIN_AGENTS.find((d) => d.id === "planner")!;
    expect(planner.tools).not.toContain("run_command");
    expect(planner.tools).not.toContain("write_file");
    expect(planner.body).toContain("Report contract");
    expect(planner.body).toContain("Risks");
    expect(planner.body).toContain("someone else executes it");
  });

  it("explorer body enforces the context-frugal report contract", () => {
    const body = BUILTIN_AGENTS.find((d) => d.id === "explorer")!.body!;
    expect(body).toContain("Report contract");
    expect(body).toContain("path:line — fact");
    expect(body).toContain("~30 lines");
    expect(body).toContain("NO file dumps");
    expect(body).toContain("never the content itself");
    expect(body).toContain("Never narrate");
    expect(body).toContain("Open questions");
  });

  it("reviewer body follows the code-review skill philosophy", () => {
    const body = BUILTIN_AGENTS.find((d) => d.id === "reviewer")!.body!;
    expect(body).toContain("Report format");
    expect(body).toContain("correctness > safety >");
    expect(body).toContain("never rewrite the author's style");
    expect(body).toContain('Re-check each "bug"');
    expect(body).toContain("smallest");
    expect(body).toContain("file:line");
    expect(body).toContain("ship / fix-first / needs-rework");
  });

  it("withBuiltinAgents merges builtins at the lowest priority", () => {
    expect(withBuiltinAgents([]).every((d) => d.scope === "builtin")).toBe(true);
    expect(withBuiltinAgents([])).toHaveLength(BUILTIN_AGENTS.length);

    const projectExplorer = {
      ...BUILTIN_AGENTS[0]!,
      scope: "project" as const,
      description: "project-specific explorer",
    };
    const merged = withBuiltinAgents([projectExplorer]);
    expect(merged.filter((d) => d.id === "explorer")).toHaveLength(1);
    expect(merged.find((d) => d.id === "explorer")!.scope).toBe("project");
    expect(merged.find((d) => d.id === "reviewer")!.scope).toBe("builtin");
  });

  describe("loader integration", () => {
    let workspace: string;
    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), "sf-builtins-"));
    });
    afterEach(() => {
      rmSync(workspace, { recursive: true, force: true });
    });

    it("a project def with a builtin id overrides the builtin", () => {
      const root = join(workspace, ".seekforge", "agents");
      mkdirSync(join(root, "explorer"), { recursive: true });
      writeFileSync(
        join(root, "explorer", "AGENT.md"),
        "---\nname: explorer\ndescription: custom explorer\nmode: ask\n---\nbody",
      );
      const defs = withBuiltinAgents(loadAgentDefinitionsFromDirs([{ scope: "project", path: root }]));
      const explorer = defs.find((d) => d.id === "explorer")!;
      expect(explorer.scope).toBe("project");
      expect(explorer.description).toBe("custom explorer");
      // the other builtin is untouched
      expect(defs.find((d) => d.id === "reviewer")!.scope).toBe("builtin");
    });

    it("loadAgentDefinitions always includes the builtin ids", () => {
      const ids = loadAgentDefinitions(workspace).map((d) => d.id);
      expect(ids).toContain("explorer");
      expect(ids).toContain("reviewer");
    });
  });
});
