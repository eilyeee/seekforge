import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importExternalSkill, parseFrontmatterSkill } from "../../src/skills/import.js";
import { loadSkillsFromDirs } from "../../src/skills/load.js";

const META_KIM_STYLE = `---
name: meta-theory
version: 3.0.0
author: someone
user-invocable: true
trigger: "元理论|meta theory|governance|治理|重构|debug"
tools:
  - shell
  - filesystem
description: |
  Executable governance dispatcher. It classifies the run,
  routes owner + verification, and closes with evidence.
---

# Meta-Theory Dispatcher

## Purpose
Run governance as an executable system.

## Procedure
1. Classify the run.
2. Route and verify.
`;

describe("parseFrontmatterSkill", () => {
  it("parses Meta_Kim-style frontmatter incl. block-scalar description and | triggers", () => {
    const s = parseFrontmatterSkill(META_KIM_STYLE);
    expect(s.id).toBe("meta-theory");
    expect(s.description).toContain("governance dispatcher");
    expect(s.description).not.toContain("\n");
    expect(s.triggers).toEqual(["元理论", "meta theory", "governance", "治理", "重构", "debug"]);
    expect(s.body.startsWith("# Meta-Theory Dispatcher")).toBe(true);
    expect(s.body).not.toContain("---\nname:");
  });

  it("kebabizes names and rejects unusable ones", () => {
    expect(parseFrontmatterSkill('---\nname: My Cool_Skill\n---\nbody').id).toBe("my-cool-skill");
    expect(() => parseFrontmatterSkill("---\nversion: 1\n---\nbody")).toThrow(/name/);
    expect(() => parseFrontmatterSkill("# no frontmatter at all")).toThrow(/frontmatter/);
  });
});

describe("importExternalSkill", () => {
  let src: string;
  let target: string;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "sf-import-src-"));
    target = mkdtempSync(join(tmpdir(), "sf-import-dst-"));
    writeFileSync(join(src, "SKILL.md"), META_KIM_STYLE);
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  });

  it("imports a skill dir and the result loads through the registry", () => {
    const { dir, skill } = importExternalSkill(src, { targetRoot: target });
    expect(skill.id).toBe("meta-theory");
    const meta = JSON.parse(readFileSync(join(dir, "skill.json"), "utf8"));
    expect(meta.risk).toBe("medium"); // imported = medium trust
    expect(meta.enabled).toBe(true);

    const loaded = loadSkillsFromDirs([{ scope: "global", path: target }]);
    const imported = loaded.find((s) => s.id === "meta-theory");
    expect(imported).toBeDefined();
    expect(imported!.scope).toBe("global");
    expect(imported!.triggers).toContain("治理");
    expect(imported!.content).toContain("Meta-Theory Dispatcher");
  });

  it("refuses to overwrite without force, replaces with force", () => {
    importExternalSkill(src, { targetRoot: target });
    expect(() => importExternalSkill(src, { targetRoot: target })).toThrow(/--force/);
    expect(() => importExternalSkill(src, { targetRoot: target, force: true })).not.toThrow();
  });
});
