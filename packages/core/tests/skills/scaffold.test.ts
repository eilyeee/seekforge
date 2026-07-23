import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillScaffold, loadSkillsFromDirs } from "../../src/skills/index.js";
import { makeTempDir } from "./helpers.js";

describe("createSkillScaffold", () => {
  it("creates skill.json and SKILL.md and returns the dir path", () => {
    const ws = makeTempDir();
    const dir = createSkillScaffold(ws, "my-skill");
    expect(dir).toBe(path.join(ws, ".seekforge", "skills", "my-skill"));

    const json = JSON.parse(fs.readFileSync(path.join(dir, "skill.json"), "utf8"));
    expect(json).toEqual({
      id: "my-skill",
      name: "my-skill",
      description: "",
      tags: [],
      triggers: [],
      priority: 50,
      enabled: true,
      risk: "medium",
    });

    const md = fs.readFileSync(path.join(dir, "SKILL.md"), "utf8");
    for (const section of [
      "## When to Use",
      "## Do Not Use When",
      "## Required Context",
      "## Procedure",
      "## Verification",
      "## Common Mistakes",
    ]) {
      expect(md).toContain(section);
    }
  });

  it("produces a scaffold that loadSkillsFromDirs accepts", () => {
    const ws = makeTempDir();
    createSkillScaffold(ws, "fresh");
    const skills = loadSkillsFromDirs([{ scope: "project", path: path.join(ws, ".seekforge", "skills") }]);
    const fresh = skills.find((s) => s.id === "fresh");
    expect(fresh).toMatchObject({ scope: "project", priority: 50, risk: "medium" });
  });

  it("throws when the directory already exists", () => {
    const ws = makeTempDir();
    createSkillScaffold(ws, "dup");
    expect(() => createSkillScaffold(ws, "dup")).toThrow(/already exists/);
  });

  it.each(["", "Bad", "-leading", "has space", "中文", "a_b"])("rejects invalid id %j", (id) => {
    const ws = makeTempDir();
    expect(() => createSkillScaffold(ws, id)).toThrow(/invalid skill id/);
    expect(fs.existsSync(path.join(ws, ".seekforge"))).toBe(false);
  });

  it("rejects ids beyond the storage-safe length limit", () => {
    const ws = makeTempDir();
    expect(() => createSkillScaffold(ws, "a".repeat(129))).toThrow(/invalid skill id/);
  });

  it("refuses a linked skills store instead of writing through it", () => {
    const ws = makeTempDir();
    const outside = makeTempDir();
    fs.mkdirSync(path.join(ws, ".seekforge"));
    fs.symlinkSync(outside, path.join(ws, ".seekforge", "skills"));
    expect(() => createSkillScaffold(ws, "linked")).toThrow(/physical directory/);
    expect(fs.existsSync(path.join(outside, "linked"))).toBe(false);
  });
});
