import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { logSkillOutcome, logSkillUsage, readSkillEffectiveness } from "../../src/skills/index.js";
import type { SkillSelection } from "../../src/skills/index.js";
import { makeSkill, makeTempDir } from "./helpers.js";

function sel(id: string, score = 4.5): SkillSelection {
  return { skill: makeSkill(id), score, reason: 'trigger "fix"' };
}

describe("logSkillUsage", () => {
  it("appends one valid JSON line per selection, creating parents", () => {
    const ws = makeTempDir();
    logSkillUsage(ws, "session-1", [sel("bugfix"), sel("small-code-change", 2.3)]);

    const file = path.join(ws, ".seekforge", "skills-usage.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({
      sessionId: "session-1",
      skillId: "bugfix",
      scope: "builtin",
      score: 4.5,
      reason: 'trigger "fix"',
    });
    expect(typeof first.ts).toBe("string");
    expect(Number.isNaN(Date.parse(first.ts))).toBe(false);

    expect(JSON.parse(lines[1]!).skillId).toBe("small-code-change");
  });

  it("appends across calls instead of overwriting", () => {
    const ws = makeTempDir();
    logSkillUsage(ws, "s1", [sel("a")]);
    logSkillUsage(ws, "s2", [sel("b")]);
    const file = path.join(ws, ".seekforge", "skills-usage.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).sessionId).toBe("s2");
  });

  it("is a no-op for empty selections", () => {
    const ws = makeTempDir();
    logSkillUsage(ws, "s1", []);
    expect(fs.existsSync(path.join(ws, ".seekforge", "skills-usage.jsonl"))).toBe(false);
  });

  it("never follows a linked telemetry target or changes its destination", () => {
    const ws = makeTempDir();
    const outside = path.join(makeTempDir(), "outside.jsonl");
    fs.writeFileSync(outside, "sentinel\n");
    fs.mkdirSync(path.join(ws, ".seekforge"));
    fs.symlinkSync(outside, path.join(ws, ".seekforge", "skills-usage.jsonl"));
    expect(() => logSkillUsage(ws, "s1", [sel("a")])).not.toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("sentinel\n");
  });

  it("correlates terminal outcomes and learns only after three samples", () => {
    const ws = makeTempDir();
    for (let index = 0; index < 3; index++) {
      const sessionId = `s${index}`;
      logSkillUsage(ws, sessionId, [sel("reliable")]);
      logSkillOutcome(ws, sessionId, ["reliable"], { success: true, toolCalls: 2, costUsd: 0.01 });
    }
    const [stats] = readSkillEffectiveness(ws);
    expect(stats).toMatchObject({
      skillId: "reliable",
      selections: 3,
      completedOutcomes: 3,
      successes: 3,
      successRate: 1,
      averageToolCalls: 2,
      averageCostUsd: 0.01,
    });
    expect(stats!.learnedAdjustment).toBeGreaterThan(0);
    expect(stats!.learnedAdjustment).toBeLessThanOrEqual(0.75);
  });
});
