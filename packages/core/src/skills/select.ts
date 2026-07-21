import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LIMITS } from "@seekforge/shared";
import { readUtf8FileBoundedSync } from "../util/fs.js";
import type { Skill, SkillSelection } from "./types.js";

export type SelectSkillsOptions = {
  /** Used to detect frameworks from package.json for appliesTo matching. */
  workspace?: string;
  /** Max selections, default 3 (DEFAULT_LIMITS.maxActiveSkills). */
  max?: number;
};

const SCORE_PER_TRIGGER = 4;
const SCORE_PER_TAG = 2;
const SCORE_FRAMEWORK = 2;

const KNOWN_FRAMEWORKS = ["vue", "react", "next", "nuxt", "vite", "express"];

/** Frameworks present as dependencies in <workspace>/package.json. */
function detectFrameworks(workspace: string): string[] {
  try {
    const packageFile = fs.realpathSync(path.join(workspace, "package.json"));
    const raw = JSON.parse(readUtf8FileBoundedSync(packageFile, 1024 * 1024)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...raw.dependencies, ...raw.devDependencies };
    return KNOWN_FRAMEWORKS.filter((fw) => fw in deps);
  } catch {
    return [];
  }
}

/**
 * Rule-based selection: triggers > tags/keywords > frameworks > priority.
 * Only skills with a positive match score qualify; priority is a tie-breaker
 * only. Equal scores order deterministically by id.
 */
export function selectSkills(task: string, skills: Skill[], opts?: SelectSkillsOptions): SkillSelection[] {
  const taskLower = task.toLowerCase();
  // package.json is read lazily, once, and only when a skill needs it.
  let frameworks: string[] | undefined;
  const detectedFrameworks = (): string[] => {
    frameworks ??= opts?.workspace ? detectFrameworks(opts.workspace) : [];
    return frameworks;
  };

  const selections: SkillSelection[] = [];
  for (const skill of skills) {
    let score = 0;
    const reasons: string[] = [];
    for (const trigger of skill.triggers) {
      if (trigger && taskLower.includes(trigger.toLowerCase())) {
        score += SCORE_PER_TRIGGER;
        reasons.push(`trigger "${trigger}"`);
      }
    }
    for (const tag of skill.tags) {
      if (tag && taskLower.includes(tag.toLowerCase())) {
        score += SCORE_PER_TAG;
        reasons.push(`tag ${tag}`);
      }
    }
    const wanted = skill.appliesTo?.frameworks;
    if (wanted && wanted.length > 0) {
      const hit = wanted.find((fw) => detectedFrameworks().includes(fw.toLowerCase()));
      if (hit) {
        score += SCORE_FRAMEWORK;
        reasons.push(`framework ${hit}`);
      }
    }
    if (score <= 0) continue;
    selections.push({
      skill,
      score: score + skill.priority / 100,
      reason: reasons.join("; "),
    });
  }

  selections.sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id));
  return selections.slice(0, opts?.max ?? DEFAULT_LIMITS.maxActiveSkills);
}
