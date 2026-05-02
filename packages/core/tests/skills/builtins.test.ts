import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS } from "../../src/skills/index.js";

const REQUIRED_SECTIONS = [
  "## When to Use",
  "## Do Not Use When",
  "## Required Context",
  "## Procedure",
  "## Verification",
  "## Common Mistakes",
];

describe("BUILTIN_SKILLS", () => {
  it("contains exactly the eight builtin skills with unique ids", () => {
    expect(BUILTIN_SKILLS).toHaveLength(8);
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(8);
    expect(ids.sort()).toEqual([
      "bugfix",
      "code-review",
      "github-issue-pr",
      "security-review",
      "simplify",
      "small-code-change",
      "test-failure-fix",
      "verify-change",
    ]);
  });

  it("github-issue-pr describes the gh issue → branch → PR procedure", () => {
    const skill = BUILTIN_SKILLS.find((s) => s.id === "github-issue-pr")!;
    expect(skill).toBeDefined();
    expect(skill.triggers).toContain("github");
    expect(skill.triggers).toContain("issue");
    expect(skill.content).toContain("gh issue view");
    expect(skill.content).toContain("git checkout -b fix/");
    expect(skill.content).toContain("gh pr create");
    // gh / git push must never auto-run — the content has to say so.
    expect(skill.content).toMatch(/NEVER auto-run/);
  });

  it("every builtin is enabled, builtin-scoped, and low risk", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.enabled).toBe(true);
      expect(skill.scope).toBe("builtin");
      expect(skill.risk).toBe("low");
      expect(skill.name.length).toBeGreaterThan(0);
      expect(skill.description.length).toBeGreaterThan(0);
      expect(skill.triggers.length).toBeGreaterThan(0);
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  it("every SKILL.md content has the required sections", () => {
    for (const skill of BUILTIN_SKILLS) {
      for (const section of REQUIRED_SECTIONS) {
        expect(skill.content, `${skill.id} missing ${section}`).toContain(section);
      }
    }
  });

  it("procedures reference the agent's actual tools", () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.content).toMatch(/search_text|read_file|apply_patch/);
      expect(skill.content).toContain("run_command");
    }
  });
});
