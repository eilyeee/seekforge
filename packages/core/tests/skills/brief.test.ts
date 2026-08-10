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

  /** Steps that wrap, so a line-boundary cut is not a step-boundary cut. */
  const wrapped = (count: number): string =>
    [
      "## Procedure",
      ...Array.from({ length: count }, (_, i) => `${i + 1}. begin-${i + 1} ${"y".repeat(60)}\n   end-${i + 1}`),
    ].join("\n");

  it("gives an unused share to a skill that can spend it, not to an even split", () => {
    const brief = buildSkillBrief([sel("tiny", "## Procedure\n1. go"), sel("long", wrapped(40))]) ?? "";
    const evenSplitProcedure = Math.floor((SKILL_BRIEF_MAX_CHARS - 2) / 2);
    const long = brief.slice(brief.indexOf("## long"));
    // `tiny` needs almost nothing, so `long` must receive well beyond half.
    expect(long.length).toBeGreaterThan(evenSplitProcedure);
    expect(brief).toContain("1. go");
  });

  it("never truncates inside a step", () => {
    const brief = buildSkillBrief([sel("wrap", wrapped(40))]) ?? "";
    expect(brief).toContain("…[truncated");
    for (let step = 1; step <= 40; step++) {
      if (brief.includes(`begin-${step} `)) {
        expect(brief, `step ${step} was cut in half`).toContain(`end-${step}`);
      }
    }
  });

  it("spends the budget it reserved instead of leaving the slack unused", () => {
    const brief = buildSkillBrief([sel("a", wrapped(40)), sel("b", wrapped(40)), sel("c", wrapped(40))]) ?? "";
    expect(brief.length).toBeLessThanOrEqual(SKILL_BRIEF_MAX_CHARS);
    // Cutting at a step boundary hands budget back; it has to be re-offered.
    expect(brief.length).toBeGreaterThan(SKILL_BRIEF_MAX_CHARS * 0.9);
  });

  it("honours an explicit budget and refuses an absurd one", () => {
    const wide = buildSkillBrief([sel("a", wrapped(40)), sel("b", wrapped(40))], 4_000) ?? "";
    const narrow = buildSkillBrief([sel("a", wrapped(40)), sel("b", wrapped(40))]) ?? "";
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(wide.length).toBeLessThanOrEqual(4_000);
    // A caller cannot buy an unbounded prompt: the cap is clamped, and a
    // nonsensical value falls back to the default rather than to zero.
    const absurd = buildSkillBrief([sel("a", wrapped(40))], 10 ** 9) ?? "";
    expect(absurd.length).toBeLessThanOrEqual(4 * SKILL_BRIEF_MAX_CHARS);
    const broken = buildSkillBrief([sel("a", wrapped(40))], Number.NaN) ?? "";
    expect(broken.length).toBeLessThanOrEqual(SKILL_BRIEF_MAX_CHARS);
    expect(broken.length).toBeGreaterThan(0);
  });

  it("keeps every selection when demand is lopsided", () => {
    // Redistributing slack must not overcommit and silently drop the last entry.
    const brief = buildSkillBrief([
      sel("small", "## Procedure\n1. go"),
      sel("medium", wrapped(6)),
      sel("large", wrapped(40)),
    ]);
    expect(brief).toContain("## small");
    expect(brief).toContain("## medium");
    expect(brief).toContain("## large");
    expect(brief!.length).toBeLessThanOrEqual(SKILL_BRIEF_MAX_CHARS);
  });
});
