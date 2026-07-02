/**
 * Skill-effectiveness ranking.
 *
 * The core logs which skills it selected per session into the workspace's
 * .seekforge/skills-usage.jsonl; task-runner captures that into
 * TaskResult.skills. Here we aggregate across a full eval run: for each skill
 * that fired, the tasks where it was active, their success rate / avg score /
 * avg turns, and how those compare to the run-wide baseline (all tasks).
 *
 * If skills rarely fire on the current dataset the table is sparse — that is
 * honest and expected; the mechanism is still correct.
 */

import type { TaskResult } from "./task-runner.js";

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export type SkillStats = {
  skillId: string;
  /** How many tasks selected this skill. */
  timesUsed: number;
  /** Task ids where the skill was active. */
  tasks: string[];
  /** Success rate (0..1) over the tasks where it fired. */
  successRate: number;
  /** Avg core score over firing tasks (undefined if none had a score). */
  avgScore?: number;
  /** Avg turns over firing tasks (undefined if none had turns). */
  avgTurns?: number;
  /**
   * avgTurns(active) − avgTurns(baseline over all tasks). Negative = the skill
   * coincided with fewer turns. Undefined when either side lacks turn data.
   */
  avgTurnsDelta?: number;
  /** successRate(active) − successRate(all tasks). */
  successRateDelta: number;
};

export type SkillRanking = {
  /** Tasks that fired ≥1 skill (denominator awareness). */
  tasksWithSkills: number;
  totalTasks: number;
  /** Run-wide baselines for delta context. */
  baseline: { successRate: number; avgScore?: number; avgTurns?: number };
  skills: SkillStats[];
};

/**
 * Aggregates skill usage across an eval run. Sort: most-used first, then by
 * success rate, then skill id for determinism.
 */
export function rankSkills(results: TaskResult[]): SkillRanking {
  const totalTasks = results.length;
  const baselineSuccess =
    totalTasks === 0 ? 0 : results.filter((r) => r.success).length / totalTasks;
  const baselineScore = mean(
    results.map((r) => r.metrics.score).filter((s): s is number => s !== undefined),
  );
  const baselineTurns = mean(
    results.map((r) => r.metrics.turns).filter((t): t is number => t !== undefined),
  );

  // skillId -> the task results where it fired (dedup per task: a skill counts
  // once per task even if logged twice).
  const bySkill = new Map<string, TaskResult[]>();
  let tasksWithSkills = 0;
  for (const r of results) {
    if (r.skills.length > 0) tasksWithSkills++;
    const seen = new Set<string>();
    for (const usage of r.skills) {
      if (seen.has(usage.skillId)) continue;
      seen.add(usage.skillId);
      const list = bySkill.get(usage.skillId) ?? [];
      list.push(r);
      bySkill.set(usage.skillId, list);
    }
  }

  const skills: SkillStats[] = [];
  for (const [skillId, firing] of bySkill) {
    const successRate = firing.filter((r) => r.success).length / firing.length;
    const avgScore = mean(
      firing.map((r) => r.metrics.score).filter((s): s is number => s !== undefined),
    );
    const avgTurns = mean(
      firing.map((r) => r.metrics.turns).filter((t): t is number => t !== undefined),
    );
    skills.push({
      skillId,
      timesUsed: firing.length,
      tasks: firing.map((r) => r.taskId),
      successRate,
      ...(avgScore !== undefined ? { avgScore } : {}),
      ...(avgTurns !== undefined ? { avgTurns } : {}),
      ...(avgTurns !== undefined && baselineTurns !== undefined
        ? { avgTurnsDelta: avgTurns - baselineTurns }
        : {}),
      successRateDelta: successRate - baselineSuccess,
    });
  }

  skills.sort(
    (a, b) =>
      b.timesUsed - a.timesUsed ||
      b.successRate - a.successRate ||
      a.skillId.localeCompare(b.skillId),
  );

  return {
    tasksWithSkills,
    totalTasks,
    baseline: {
      successRate: baselineSuccess,
      ...(baselineScore !== undefined ? { avgScore: baselineScore } : {}),
      ...(baselineTurns !== undefined ? { avgTurns: baselineTurns } : {}),
    },
    skills,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function signedPct(value: number): string {
  const rounded = Math.round(value * 100);
  // Check the sign AFTER rounding, but treat a rounded-to-zero delta as "0%":
  // Math.round(-0.4) is -0, and -0 >= 0 is true, so a marginally-worse skill
  // would otherwise print a misleading "+0%".
  if (rounded === 0) return "0%";
  return rounded > 0 ? `+${rounded}%` : `${rounded}%`;
}

function num(value: number | undefined, digits = 1): string {
  return value === undefined ? "-" : value.toFixed(digits);
}

function signedNum(value: number | undefined, digits = 1): string {
  if (value === undefined) return "-";
  const fixed = value.toFixed(digits);
  // toFixed can render a tiny negative as "-0.0"; show a rounded-to-zero delta
  // unsigned rather than "+0.0"/"-0.0".
  if (Number.parseFloat(fixed) === 0) return (0).toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

/** Renders the skill ranking as a markdown table (sparse when skills rarely fire). */
export function toSkillRankingMarkdown(ranking: SkillRanking): string {
  const lines: string[] = [
    "### Skill-effectiveness ranking",
    "",
    `Skills fired on ${ranking.tasksWithSkills}/${ranking.totalTasks} tasks. ` +
      `Baseline: success ${pct(ranking.baseline.successRate)}, ` +
      `avg score ${num(ranking.baseline.avgScore)}, avg turns ${num(ranking.baseline.avgTurns)}.`,
    "",
  ];
  if (ranking.skills.length === 0) {
    lines.push("_No skills fired on this eval run._");
    return lines.join("\n");
  }
  lines.push("| Skill | Times used | Success (active) | Δ vs baseline | Avg score | Avg turns | Turns Δ |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const s of ranking.skills) {
    lines.push(
      `| ${s.skillId} | ${s.timesUsed} | ${pct(s.successRate)} | ${signedPct(s.successRateDelta)} | ` +
        `${num(s.avgScore)} | ${num(s.avgTurns)} | ${signedNum(s.avgTurnsDelta)} |`,
    );
  }
  return lines.join("\n");
}
