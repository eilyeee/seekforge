import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_SKILLS,
  loadSkillsFromDirs,
  removeSkill,
  setSkillEnabled,
} from "../../src/skills/index.js";
import { makeTempDir, skillJson, writeSkillDir } from "./helpers.js";

const MD = "# Skill\n\n## Procedure\n\n1. do it\n";

/** loadSkillsFromDirs reading only the project layer under <ws>/.seekforge/skills. */
function loadProject(workspace: string) {
  return loadSkillsFromDirs([
    { scope: "project", path: path.join(workspace, ".seekforge", "skills") },
  ]);
}

describe("setSkillEnabled — builtins via override marker", () => {
  it("disables a builtin by writing an enabled:false marker, then re-enables", () => {
    const ws = makeTempDir();
    expect(loadProject(ws).some((s) => s.id === "bugfix")).toBe(true);

    const dis = setSkillEnabled(ws, "bugfix", false);
    expect(dis.action).toBe("marker");
    expect(fs.existsSync(path.join(ws, ".seekforge", "skills", "bugfix", "skill.json"))).toBe(true);
    // The disable marker removes the builtin from the enabled set.
    expect(loadProject(ws).some((s) => s.id === "bugfix")).toBe(false);
    // Sibling builtins are untouched.
    expect(loadProject(ws).some((s) => s.id === "test-failure-fix")).toBe(true);

    setSkillEnabled(ws, "bugfix", true);
    // Marker removed → builtin resurfaces.
    expect(fs.existsSync(path.join(ws, ".seekforge", "skills", "bugfix"))).toBe(false);
    expect(loadProject(ws).some((s) => s.id === "bugfix")).toBe(true);
  });

  it("flips enabled in place for a project skill that owns its skill.json", () => {
    const ws = makeTempDir();
    const root = path.join(ws, ".seekforge", "skills");
    writeSkillDir(root, "alpha", skillJson("alpha"), MD);
    expect(loadProject(ws).some((s) => s.id === "alpha")).toBe(true);

    setSkillEnabled(ws, "alpha", false);
    expect(loadProject(ws).some((s) => s.id === "alpha")).toBe(false);
    // SKILL.md is preserved; only the flag changed.
    expect(fs.existsSync(path.join(root, "alpha", "SKILL.md"))).toBe(true);

    setSkillEnabled(ws, "alpha", true);
    expect(loadProject(ws).some((s) => s.id === "alpha")).toBe(true);
  });

  it("throws when enabling an unknown id with nothing to flip", () => {
    const ws = makeTempDir();
    expect(() => setSkillEnabled(ws, "nope", true)).toThrow(/unknown skill/i);
  });
});

describe("removeSkill", () => {
  it("deletes a project skill directory", () => {
    const ws = makeTempDir();
    const root = path.join(ws, ".seekforge", "skills");
    writeSkillDir(root, "alpha", skillJson("alpha"), MD);
    expect(loadProject(ws).some((s) => s.id === "alpha")).toBe(true);

    const res = removeSkill(ws, "alpha");
    expect(res.id).toBe("alpha");
    expect(fs.existsSync(path.join(root, "alpha"))).toBe(false);
    expect(loadProject(ws).some((s) => s.id === "alpha")).toBe(false);
  });

  it("refuses to remove a builtin", () => {
    const ws = makeTempDir();
    expect(BUILTIN_SKILLS.some((s) => s.id === "bugfix")).toBe(true);
    expect(() => removeSkill(ws, "bugfix")).toThrow(/cannot remove builtin/i);
  });

  it("throws on an unknown id", () => {
    const ws = makeTempDir();
    expect(() => removeSkill(ws, "ghost")).toThrow(/unknown skill/i);
  });
});
