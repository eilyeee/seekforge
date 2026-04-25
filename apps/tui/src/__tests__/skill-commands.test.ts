import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachSkillContent,
  expandSkillCommand,
  findSkillByCommand,
  skillCommandSpecs,
  type SkillCommandRow,
} from "../skill-commands.js";
import type { SkillRow } from "../skills-surface.js";

const SKILLS: SkillRow[] = [
  { id: "tdd", description: "Red-green-refactor loop", scope: "project" },
  { id: "commit-style", description: "Conventional commits", scope: "builtin", disabled: true },
  { id: "My Skill!!", description: "needs sanitizing", scope: "global" },
];

describe("skillCommandSpecs", () => {
  it("builds one spec per enabled skill, in group tools", () => {
    const specs = skillCommandSpecs(SKILLS);
    expect(specs.map((s) => s.name)).toEqual(["skill:tdd", "skill:my-skill"]);
    expect(specs[0]).toEqual({
      name: "skill:tdd",
      args: "[task]",
      summary: "(skill) Red-green-refactor loop",
      group: "tools",
    });
  });

  it("excludes disabled skills", () => {
    expect(skillCommandSpecs(SKILLS).some((s) => s.name.includes("commit-style"))).toBe(false);
  });

  it("sanitizes ids into lowercase [a-z0-9-]", () => {
    const [spec] = skillCommandSpecs([{ id: "My Skill!!", description: "d" }]);
    expect(spec!.name).toBe("skill:my-skill");
  });

  it("skips skills whose id sanitizes to nothing", () => {
    expect(skillCommandSpecs([{ id: "!!!" }])).toEqual([]);
  });

  it("caps long descriptions at 60 chars and falls back to the id", () => {
    const [long] = skillCommandSpecs([{ id: "long", description: `a\n ${"x".repeat(100)}` }]);
    expect(long!.summary.startsWith("(skill) a x")).toBe(true);
    expect(long!.summary.length).toBeLessThanOrEqual("(skill) ".length + 61); // 60 + ellipsis
    expect(long!.summary).toMatch(/…$/);
    const [bare] = skillCommandSpecs([{ id: "bare" }]);
    expect(bare!.summary).toBe("(skill) bare");
  });
});

describe("expandSkillCommand", () => {
  const skill: SkillCommandRow = { id: "tdd", description: "TDD", content: "# TDD\nWrite the test first." };

  it("wraps the content and appends the task", () => {
    expect(expandSkillCommand(skill, "fix the login bug")).toBe(
      "Apply the following skill/procedure to this task.\n\n<skill>\n# TDD\nWrite the test first.\n</skill>\n\nTask: fix the login bug",
    );
  });

  it("uses the self-targeting default when no args are given", () => {
    const expanded = expandSkillCommand(skill, "  ");
    expect(expanded).toContain(
      "Task: Apply this skill to the current context — ask via ask_user if the target is unclear.",
    );
  });

  it("falls back to the description when content is missing", () => {
    const expanded = expandSkillCommand({ id: "tdd", description: "TDD procedure" }, "go");
    expect(expanded).toContain("<skill>\nTDD procedure\n</skill>");
  });
});

describe("findSkillByCommand", () => {
  it("resolves skill:<id> back to the skill (sanitized id form)", () => {
    expect(findSkillByCommand(SKILLS, "skill:tdd")?.id).toBe("tdd");
    expect(findSkillByCommand(SKILLS, "skill:my-skill")?.id).toBe("My Skill!!");
  });

  it("never returns disabled skills", () => {
    expect(findSkillByCommand(SKILLS, "skill:commit-style")).toBeNull();
  });

  it("returns null for non-skill commands and unknown ids", () => {
    expect(findSkillByCommand(SKILLS, "help")).toBeNull();
    expect(findSkillByCommand(SKILLS, "skill:")).toBeNull();
    expect(findSkillByCommand(SKILLS, "skill:nope")).toBeNull();
  });
});

describe("attachSkillContent", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-skillcmd-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("joins rows with SKILL.md content from core's loadSkills by id", () => {
    const dir = join(workspace, ".seekforge", "skills", "tdd");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "skill.json"),
      JSON.stringify({ id: "tdd", name: "TDD", description: "d", tags: [], triggers: [] }),
    );
    writeFileSync(join(dir, "SKILL.md"), "# TDD\nbody");

    const rows = attachSkillContent(workspace, [
      { id: "tdd", description: "d", scope: "project" },
      { id: "no-such-skill-xyz", description: "gone", disabled: true },
    ]);
    expect(rows[0]!.content).toBe("# TDD\nbody");
    expect(rows[1]!.content).toBeUndefined();
    // Original rows are not mutated.
    expect(rows[0]).not.toBe(SKILLS[0]);
  });
});
