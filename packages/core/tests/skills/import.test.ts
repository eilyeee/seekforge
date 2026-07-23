import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(parseFrontmatterSkill("---\nname: My Cool_Skill\n---\nbody").id).toBe("my-cool-skill");
    expect(() => parseFrontmatterSkill("---\nversion: 1\n---\nbody")).toThrow(/name/);
    expect(() => parseFrontmatterSkill("# no frontmatter at all")).toThrow(/frontmatter/);
  });

  it("handles block-scalar chomping indicators (shared parser, previously unsupported)", () => {
    // `description: |-` was NOT recognized by the old skill-only parser (it only
    // matched bare `|`/`>`), so the block body leaked as an empty description.
    const md = "---\nname: Chomp Skill\ndescription: |-\n  first line\n  second line\n---\nbody";
    const s = parseFrontmatterSkill(md);
    expect(s.id).toBe("chomp-skill");
    expect(s.description).toBe("first line second line");
  });

  it("bounds imported metadata so a successful import remains loadable", () => {
    const triggers = Array.from({ length: 100 }, (_, index) => `trigger-${index}`).join("|");
    const parsed = parseFrontmatterSkill(
      `---\nname: bounded-import\ntrigger: ${triggers}\ntags: ${"x".repeat(150)},tag\n---\nbody`,
    );
    expect(parsed.triggers).toHaveLength(64);
    expect(parsed.tags[0]).toHaveLength(100);
    expect(() => parseFrontmatterSkill(`---\nname: ${"a".repeat(129)}\n---\nbody`)).toThrow(/invalid/);
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

  it("rejects linked sources and linked force-replacement targets", () => {
    const linkRoot = mkdtempSync(join(tmpdir(), "sf-import-link-"));
    const outside = mkdtempSync(join(tmpdir(), "sf-import-outside-"));
    try {
      const linkedSource = join(linkRoot, "SKILL.md");
      symlinkSync(join(src, "SKILL.md"), linkedSource);
      expect(() => importExternalSkill(linkedSource, { targetRoot: target })).toThrow(/symbolic link/);

      symlinkSync(outside, join(target, "meta-theory"));
      expect(() => importExternalSkill(src, { targetRoot: target, force: true })).toThrow(/physical/);
      expect(readFileSync(join(src, "SKILL.md"), "utf8")).toBe(META_KIM_STYLE);
    } finally {
      rmSync(linkRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
