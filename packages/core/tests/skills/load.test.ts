import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, loadSkillsFromDirs } from "../../src/skills/index.js";
import { makeTempDir, skillJson, writeSkillDir } from "./helpers.js";

const MD = "# Skill\n\n## Procedure\n\n1. do it\n";

describe("loadSkillsFromDirs", () => {
  it("returns only builtins when no dirs are given", () => {
    const skills = loadSkillsFromDirs([]);
    expect(skills.map((s) => s.id).sort()).toEqual(BUILTIN_SKILLS.map((s) => s.id).sort());
  });

  it("layers project over global over builtin by id", () => {
    const global = makeTempDir();
    const project = makeTempDir();
    writeSkillDir(global, "alpha", skillJson("alpha", { description: "from global" }), MD);
    writeSkillDir(global, "bugfix", skillJson("bugfix", { description: "global bugfix" }), MD);
    writeSkillDir(project, "alpha", skillJson("alpha", { description: "from project" }), MD);

    const skills = loadSkillsFromDirs([
      { scope: "global", path: global },
      { scope: "project", path: project },
    ]);

    const alpha = skills.find((s) => s.id === "alpha");
    expect(alpha?.description).toBe("from project");
    expect(alpha?.scope).toBe("project");

    const bugfix = skills.find((s) => s.id === "bugfix");
    expect(bugfix?.description).toBe("global bugfix");
    expect(bugfix?.scope).toBe("global");
  });

  it("applies defaults for missing optional fields", () => {
    const project = makeTempDir();
    writeSkillDir(project, "minimal", skillJson("minimal"), MD);
    const skills = loadSkillsFromDirs([{ scope: "project", path: project }]);
    const minimal = skills.find((s) => s.id === "minimal");
    expect(minimal).toMatchObject({ priority: 50, enabled: true, risk: "medium", content: MD });
  });

  it("a project override with enabled:false disables a builtin of the same id", () => {
    const project = makeTempDir();
    writeSkillDir(project, "bugfix", skillJson("bugfix", { enabled: false }), MD);
    const skills = loadSkillsFromDirs([{ scope: "project", path: project }]);
    expect(skills.find((s) => s.id === "bugfix")).toBeUndefined();
    // The other builtins survive.
    expect(skills.find((s) => s.id === "test-failure-fix")).toBeDefined();
  });

  it("treats an enabled:false stub without SKILL.md as a pure disable marker", () => {
    const project = makeTempDir();
    // No SKILL.md, minimal json — used to disable a builtin.
    writeSkillDir(project, "bugfix", { id: "bugfix", enabled: false }, undefined);
    const skills = loadSkillsFromDirs([{ scope: "project", path: project }]);
    expect(skills.find((s) => s.id === "bugfix")).toBeUndefined();
    expect(skills.find((s) => s.id === "test-failure-fix")).toBeDefined();
  });

  it("does NOT treat an enabled:true stub without SKILL.md as a skill", () => {
    const project = makeTempDir();
    writeSkillDir(project, "newish", { id: "newish", enabled: true }, undefined);
    const skills = loadSkillsFromDirs([{ scope: "project", path: project }]);
    expect(skills.find((s) => s.id === "newish")).toBeUndefined();
  });

  it("skips malformed dirs silently and still loads valid siblings", () => {
    const project = makeTempDir();
    writeSkillDir(project, "bad-json", "{ not json", MD);
    writeSkillDir(project, "no-md", skillJson("no-md"), undefined);
    writeSkillDir(project, "bad-shape", { id: "bad-shape" }, MD); // missing required fields
    writeSkillDir(project, "good", skillJson("good"), MD);

    const skills = loadSkillsFromDirs([{ scope: "project", path: project }]);
    const ids = skills.map((s) => s.id);
    expect(ids).toContain("good");
    expect(ids).not.toContain("bad-json");
    expect(ids).not.toContain("no-md");
    expect(ids).not.toContain("bad-shape");
  });

  it("ignores missing skills roots", () => {
    const skills = loadSkillsFromDirs([{ scope: "project", path: "/nonexistent/path/skills" }]);
    expect(skills.length).toBe(BUILTIN_SKILLS.length);
  });
});
