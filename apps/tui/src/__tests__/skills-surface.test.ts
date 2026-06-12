import { describe, expect, it } from "vitest";
import { formatSkillLines } from "../skills-surface.js";

describe("formatSkillLines", () => {
  it("renders id, scope, and description", () => {
    const lines = formatSkillLines([
      { id: "tdd", scope: "project", description: "Red-green-refactor loop" },
    ]);
    expect(lines).toEqual(["tdd  (project)  Red-green-refactor loop"]);
  });

  it("appends [builtin] for builtin scope", () => {
    const [line] = formatSkillLines([
      { id: "commit-style", scope: "builtin", description: "Conventional commits" },
    ]);
    expect(line).toBe("commit-style  (builtin)  Conventional commits  [builtin]");
  });

  it("appends [disabled] for disabled skills", () => {
    const [line] = formatSkillLines([
      { id: "commit-style", scope: "builtin", description: "Conventional commits", disabled: true },
    ]);
    expect(line).toBe("commit-style  (builtin)  Conventional commits  [builtin]  [disabled]");
  });

  it("omits missing scope and description segments", () => {
    expect(formatSkillLines([{ id: "bare" }])).toEqual(["bare"]);
  });

  it("collapses whitespace and truncates long descriptions", () => {
    const [line] = formatSkillLines([
      { id: "long", scope: "global", description: `line one\n  line two ${"x".repeat(80)}` },
    ]);
    expect(line).toContain("line one line two");
    expect(line).not.toContain("\n");
    expect(line).toMatch(/…$/);
  });

  it("hints at skill import when no skills exist", () => {
    expect(formatSkillLines([])).toEqual([
      "no skills installed — seekforge skill import <path> adds one",
    ]);
  });
});
