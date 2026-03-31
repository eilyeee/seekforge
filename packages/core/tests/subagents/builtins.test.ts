import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BUILTIN_AGENTS } from "../../src/subagents/builtins.js";
import { loadAgentDefinitions, loadAgentDefinitionsFromDirs, withBuiltinAgents } from "../../src/subagents/load.js";

describe("builtin agents", () => {
  it("ships explorer and reviewer as read-only builtins", () => {
    expect(BUILTIN_AGENTS.map((d) => d.id)).toEqual(["explorer", "reviewer"]);
    for (const def of BUILTIN_AGENTS) {
      expect(def.scope).toBe("builtin");
      expect(def.mode).toBe("ask");
      expect(def.maxTurns).toBe(12);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.own).toBeDefined();
      expect(def.boundary).toBeDefined();
      expect(def.body!.length).toBeGreaterThan(200); // real procedure, not a stub
      expect(def.body).toContain("Report format");
    }
    const explorer = BUILTIN_AGENTS.find((d) => d.id === "explorer")!;
    expect(explorer.tools).toEqual(["list_files", "read_file", "search_text", "detect_project", "list_scripts"]);
    const reviewer = BUILTIN_AGENTS.find((d) => d.id === "reviewer")!;
    expect(reviewer.tools).toEqual(["list_files", "read_file", "search_text", "git_diff", "git_status"]);
  });

  it("withBuiltinAgents merges builtins at the lowest priority", () => {
    expect(withBuiltinAgents([]).map((d) => d.scope)).toEqual(["builtin", "builtin"]);

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
