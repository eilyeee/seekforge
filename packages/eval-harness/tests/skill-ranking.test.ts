import { describe, expect, it } from "vitest";
import { rankSkills, toSkillRankingMarkdown } from "../src/skill-ranking.js";
import type { SkillUsage, TaskResult } from "../src/task-runner.js";

function res(
  taskId: string,
  success: boolean,
  score: number | undefined,
  turns: number | undefined,
  skills: string[],
): TaskResult {
  const skillUsage: SkillUsage[] = skills.map((id) => ({ skillId: id, scope: "builtin", score: 4 }));
  return {
    taskId,
    success,
    checks: [],
    metrics: { turns, toolCalls: 0, failedToolCalls: 0, costUsd: 0, durationMs: 1, score },
    skills: skillUsage,
  };
}

describe("rankSkills", () => {
  it("computes per-skill success rate, avg score/turns, and baseline deltas", () => {
    const results = [
      res("t1", true, 100, 4, ["bugfix"]),
      res("t2", false, 40, 10, ["bugfix"]),
      res("t3", true, 90, 6, ["small-code-change"]),
      res("t4", true, 80, 8, []), // no skills: counts toward baseline only
    ];
    const ranking = rankSkills(results);

    expect(ranking.totalTasks).toBe(4);
    expect(ranking.tasksWithSkills).toBe(3);
    // baseline success 3/4 = 0.75
    expect(ranking.baseline.successRate).toBeCloseTo(0.75);
    expect(ranking.baseline.avgTurns).toBeCloseTo((4 + 10 + 6 + 8) / 4);

    const bugfix = ranking.skills.find((s) => s.skillId === "bugfix")!;
    expect(bugfix.timesUsed).toBe(2);
    expect(bugfix.tasks).toEqual(["t1", "t2"]);
    expect(bugfix.successRate).toBeCloseTo(0.5);
    expect(bugfix.avgScore).toBeCloseTo(70);
    expect(bugfix.avgTurns).toBeCloseTo(7);
    expect(bugfix.successRateDelta).toBeCloseTo(0.5 - 0.75);
    expect(bugfix.avgTurnsDelta).toBeCloseTo(7 - 7); // baseline avg turns is 7

    const scc = ranking.skills.find((s) => s.skillId === "small-code-change")!;
    expect(scc.timesUsed).toBe(1);
    expect(scc.successRate).toBe(1);
  });

  it("sorts by times used, then success rate, then id", () => {
    const results = [
      res("t1", true, undefined, undefined, ["a", "b"]),
      res("t2", true, undefined, undefined, ["a"]),
      res("t3", false, undefined, undefined, ["c"]),
      res("t4", true, undefined, undefined, ["c"]),
    ];
    const ranking = rankSkills(results);
    // a: 2 uses; c: 2 uses (rate 0.5); b: 1 use (rate 1.0).
    // times-used first puts a & c (2) ahead of b (1); a before c by id at equal count.
    expect(ranking.skills.map((s) => s.skillId)).toEqual(["a", "c", "b"]);
  });

  it("breaks a times-used tie by success rate, then id", () => {
    const results = [
      // x and y each fire on two tasks; x succeeds more often -> x first.
      res("t1", true, undefined, undefined, ["x", "y"]),
      res("t2", true, undefined, undefined, ["x"]),
      res("t3", false, undefined, undefined, ["x", "y"]),
      res("t4", false, undefined, undefined, ["y"]),
    ];
    const ranking = rankSkills(results);
    // x: 2 uses, rate 0.5; y: 2 uses, rate 0.0 -> x before y.
    expect(ranking.skills.map((s) => s.skillId)).toEqual(["x", "y"]);
  });

  it("dedups a skill logged twice in one task (counts once per task)", () => {
    const r = res("t1", true, 100, 5, []);
    r.skills = [
      { skillId: "bugfix", scope: "builtin", score: 4 },
      { skillId: "bugfix", scope: "builtin", score: 4 },
    ];
    const ranking = rankSkills([r]);
    expect(ranking.skills).toHaveLength(1);
    expect(ranking.skills[0]?.timesUsed).toBe(1);
  });

  it("leaves turn/score deltas undefined when data is missing", () => {
    const ranking = rankSkills([res("t1", true, undefined, undefined, ["bugfix"])]);
    const bugfix = ranking.skills[0]!;
    expect(bugfix.avgScore).toBeUndefined();
    expect(bugfix.avgTurns).toBeUndefined();
    expect(bugfix.avgTurnsDelta).toBeUndefined();
  });

  it("renders an empty-state message when no skills fired", () => {
    const md = toSkillRankingMarkdown(rankSkills([res("t1", true, 90, 5, [])]));
    expect(md).toContain("No skills fired");
    expect(md).toContain("Skills fired on 0/1 tasks");
  });

  it("renders a row per skill with signed deltas", () => {
    const md = toSkillRankingMarkdown(
      rankSkills([res("t1", true, 100, 4, ["bugfix"]), res("t2", false, 40, 8, [])]),
    );
    expect(md).toContain("| bugfix |");
    expect(md).toMatch(/\+\d+%/); // a signed success-rate delta is present
  });
});
