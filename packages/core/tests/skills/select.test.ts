import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_SKILLS, clearSkillSignalCache, selectSkills } from "../../src/skills/index.js";
import { makeSkill, makeTempDir } from "./helpers.js";

describe("selectSkills", () => {
  it("matches a Chinese trigger as a case-insensitive substring", () => {
    const selections = selectSkills("帮我修复这个登录报错", BUILTIN_SKILLS);
    expect(selections.length).toBeGreaterThan(0);
    expect(selections[0]!.skill.id).toBe("bugfix");
    expect(selections[0]!.reason).toContain('trigger "修复"');
    expect(selections[0]!.reason).toContain('trigger "报错"');
  });

  it("scores 4 per trigger and 2 per tag, plus priority/100 tie-break", () => {
    const skill = makeSkill("s1", { triggers: ["fix"], tags: ["bug"], priority: 50 });
    const [sel] = selectSkills("please fix this bug", [skill]);
    expect(sel!.score).toBeCloseTo(4 + 2 + 0.5);
    expect(sel!.reason).toBe('trigger "fix"; tag bug');
  });

  it("excludes zero-score skills even with high priority", () => {
    const skill = makeSkill("unrelated", { triggers: ["deploy"], tags: ["ops"], priority: 99 });
    expect(selectSkills("fix the login bug", [skill])).toEqual([]);
  });

  it("boosts skills whose appliesTo.frameworks match package.json deps", () => {
    const ws = makeTempDir();
    fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "x", dependencies: { vue: "^3.4.0" } }));
    const vueSkill = makeSkill("vue-skill", { appliesTo: { frameworks: ["vue"] } });

    const withWs = selectSkills("anything at all", [vueSkill], { workspace: ws });
    expect(withWs).toHaveLength(1);
    expect(withWs[0]!.reason).toContain("framework vue");
    expect(withWs[0]!.score).toBeCloseTo(2 + 0.5);

    // No workspace -> no framework signal -> zero score -> excluded.
    expect(selectSkills("anything at all", [vueSkill])).toEqual([]);
  });

  it("gives no framework signal when package.json is missing", () => {
    const ws = makeTempDir();
    const vueSkill = makeSkill("vue-skill", { appliesTo: { frameworks: ["vue"] } });
    expect(selectSkills("anything", [vueSkill], { workspace: ws })).toEqual([]);
  });

  it("caps at 3 by default and honors opts.max", () => {
    const skills = ["a", "b", "c", "d"].map((id) => makeSkill(id, { triggers: ["fix"] }));
    expect(selectSkills("fix it", skills)).toHaveLength(3);
    expect(selectSkills("fix it", skills, { max: 2 })).toHaveLength(2);
  });

  it("orders equal scores deterministically by id", () => {
    const skills = [
      makeSkill("zeta", { triggers: ["fix"], priority: 50 }),
      makeSkill("alpha", { triggers: ["fix"], priority: 50 }),
    ];
    const ids = selectSkills("fix it", skills).map((s) => s.skill.id);
    expect(ids).toEqual(["alpha", "zeta"]);
    // Same input order independence.
    const idsReversed = selectSkills("fix it", [...skills].reverse()).map((s) => s.skill.id);
    expect(idsReversed).toEqual(["alpha", "zeta"]);
  });

  it("uses priority as tie-breaker between equally matched skills", () => {
    const skills = [
      makeSkill("low", { triggers: ["fix"], priority: 10 }),
      makeSkill("high", { triggers: ["fix"], priority: 90 }),
    ];
    const ids = selectSkills("fix it", skills).map((s) => s.skill.id);
    expect(ids).toEqual(["high", "low"]);
  });

  it("counts duplicate normalized metadata only once and matches Latin words at boundaries", () => {
    const skill = makeSkill("deduped", { triggers: ["fix", " FIX "], tags: ["bug", "BUG"] });
    expect(selectSkills("please fix this bug", [skill])[0]!.score).toBeCloseTo(4 + 2 + 0.5);
    expect(selectSkills("use a prefix and debugged output", [skill])).toEqual([]);
  });

  it("matches workspace languages and file patterns", () => {
    const ws = makeTempDir();
    fs.mkdirSync(path.join(ws, "src"));
    fs.writeFileSync(path.join(ws, "src", "agent.ts"), "export {};\n");
    const skill = makeSkill("ts-agent", {
      appliesTo: { languages: ["TypeScript"], filePatterns: ["src/**/*.ts"] },
    });
    const selected = selectSkills("unrelated request", [skill], { workspace: ws });
    expect(selected[0]!.reason).toContain("language typescript");
    expect(selected[0]!.reason).toContain("file src/**/*.ts");
  });

  it("requires explicit opt-in for high-risk auto selection", () => {
    const skill = makeSkill("dangerous", { risk: "high", triggers: ["deploy"] });
    expect(selectSkills("deploy now", [skill])).toEqual([]);
    expect(selectSkills("deploy now", [skill], { allowHighRisk: true })).toHaveLength(1);
  });

  it("validates the caller-provided selection cap", () => {
    expect(() => selectSkills("fix", [], { max: -1 })).toThrow(RangeError);
    expect(() => selectSkills("fix", [], { max: 65 })).toThrow(RangeError);
  });

  it("uses negative triggers as a hard automatic-selection veto", () => {
    const skill = makeSkill("backend-only", { triggers: ["fix"], negativeTriggers: ["frontend"] });
    expect(selectSkills("fix the frontend", [skill])).toEqual([]);
    expect(selectSkills("fix the backend", [skill])).toHaveLength(1);
  });

  it("retrieves a skill from descriptive content when metadata has no explicit match", () => {
    const skill = makeSkill("database-tuning", {
      description: "Diagnose slow PostgreSQL query plans and missing indexes",
      content: "# Database tuning\n\n## Procedure\n\nInspect PostgreSQL explain plans and index selectivity.\n",
    });
    const selected = selectSkills("Our PostgreSQL query plan is slow", [skill]);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.reason).toMatch(/lexical|semantic/);
  });

  it("injects dependencies first and resolves conflicts by ranking", () => {
    const base = makeSkill("base", { order: 10 });
    const preferred = makeSkill("preferred", {
      triggers: ["ship"],
      dependsOn: ["base"],
      conflictsWith: ["legacy"],
    });
    const legacy = makeSkill("legacy", { triggers: ["ship"], priority: 10, conflictsWith: ["preferred"] });
    expect(selectSkills("ship it", [legacy, preferred, base], { max: 3 }).map((item) => item.skill.id)).toEqual([
      "base",
      "preferred",
    ]);
  });

  it("invalidates cached workspace signals after a directory identity changes", () => {
    const ws = makeTempDir();
    const skill = makeSkill("rust", { appliesTo: { languages: ["rust"] } });
    clearSkillSignalCache();
    expect(selectSkills("anything", [skill], { workspace: ws })).toEqual([]);
    fs.writeFileSync(path.join(ws, "main.rs"), "fn main() {}\n");
    expect(selectSkills("anything", [skill], { workspace: ws })).toHaveLength(1);
  });
});
