import { describe, expect, it } from "vitest";
import { buildSkillBrief, SKILL_BRIEF_MAX_CHARS } from "../../src/skills/index.js";
import type { SkillSelection } from "../../src/skills/index.js";
import { makeSkill } from "./helpers.js";

function sel(id: string, content: string, description = `description of ${id}`): SkillSelection {
  return { skill: makeSkill(id, { content, description }), score: 4.5, reason: 'trigger "fix"' };
}

describe("buildSkillBrief", () => {
  it("returns undefined when nothing is selected", () => {
    expect(buildSkillBrief([])).toBeUndefined();
  });

  it("extracts the Procedure section and stops at the next heading", () => {
    const content = [
      "# Skill",
      "",
      "## When to Use",
      "- whenever",
      "",
      "## Procedure",
      "1. step one",
      "2. step two",
      "",
      "## Verification",
      "- never include this",
    ].join("\n");
    const brief = buildSkillBrief([sel("my-skill", content)]);
    expect(brief).toContain("## my-skill");
    expect(brief).toContain("description of my-skill");
    expect(brief).toContain("1. step one");
    expect(brief).toContain("2. step two");
    expect(brief).not.toContain("never include this");
    expect(brief).not.toContain("whenever");
  });

  it("falls back to the first 20 lines when there is no Procedure heading", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const brief = buildSkillBrief([sel("no-proc", lines.join("\n"))]);
    expect(brief).toContain("line 20");
    expect(brief).not.toContain("line 21");
  });

  it("caps the total brief at 2500 chars", () => {
    const huge = `## Procedure\n${"x".repeat(5000)}`;
    const brief = buildSkillBrief([sel("a", huge), sel("b", huge)]);
    expect(brief).toBeDefined();
    expect(brief!.length).toBeLessThanOrEqual(SKILL_BRIEF_MAX_CHARS);
  });

  it("joins multiple selections, each headed by its id", () => {
    const content = "## Procedure\n1. go";
    const brief = buildSkillBrief([sel("first", content), sel("second", content)]);
    expect(brief).toContain("## first");
    expect(brief).toContain("## second");
  });

  it("recognizes localized workflow headings and identifies provenance and risk", () => {
    const selection = sel("localized", "# 技能\n\n## 步骤\n1. 执行\n\n## 其他\n不要注入");
    const brief = buildSkillBrief([selection]);
    expect(brief).toContain("## localized [builtin, risk=low]");
    expect(brief).toContain("1. 执行");
    expect(brief).not.toContain("不要注入");
  });

  it("reserves prompt space fairly so a later skill is not erased", () => {
    const huge = `## Procedure\n${"x".repeat(5000)}`;
    const brief = buildSkillBrief([sel("first", huge), sel("second", huge), sel("third", huge)]);
    expect(brief).toContain("## first");
    expect(brief).toContain("## second");
    expect(brief).toContain("## third");
  });
});
