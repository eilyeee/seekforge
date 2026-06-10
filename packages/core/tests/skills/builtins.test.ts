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
  it("contains exactly the three builtin skills with unique ids", () => {
    expect(BUILTIN_SKILLS).toHaveLength(3);
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.sort()).toEqual(["bugfix", "small-code-change", "test-failure-fix"]);
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
