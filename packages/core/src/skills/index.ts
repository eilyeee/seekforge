/**
 * Skills module: loading, rule-based selection, brief building, usage log.
 *
 * Layers (docs/11-skills-system.md): project > global > builtin.
 *   builtin   shipped in-package (BUILTIN_SKILLS)
 *   global    ~/.seekforge/skills/<id>/{skill.json,SKILL.md}
 *   project   .seekforge/skills/<id>/{skill.json,SKILL.md}
 *
 * Implemented in the skills work stream; stubs until merged.
 */

export type SkillScope = "builtin" | "global" | "project";

export type Skill = {
  id: string;
  scope: SkillScope;
  name: string;
  description: string;
  tags: string[];
  /** Substrings matched against the task text (case-insensitive). */
  triggers: string[];
  appliesTo?: {
    languages?: string[];
    frameworks?: string[];
    filePatterns?: string[];
  };
  priority: number;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  /** Full SKILL.md content. */
  content: string;
};

export type SkillSelection = {
  skill: Skill;
  score: number;
  reason: string;
};

/** Skills are procedure suggestions only — they never grant permissions. */
export const BUILTIN_SKILLS: Skill[] = [];

/**
 * Loads builtin + global + project skills; a project/global skill with the
 * same id overrides lower layers. Disabled skills are excluded. Malformed
 * skill dirs are skipped, never thrown.
 */
export function loadSkills(_workspace: string): Skill[] {
  return [];
}

export type SelectSkillsOptions = {
  /** Used to detect frameworks from package.json for appliesTo matching. */
  workspace?: string;
  /** Max selections, default 3 (DEFAULT_LIMITS.maxActiveSkills). */
  max?: number;
};

/** Rule-based selection: triggers > tags/keywords > frameworks > priority. */
export function selectSkills(_task: string, _skills: Skill[], _opts?: SelectSkillsOptions): SkillSelection[] {
  return [];
}

/** Compressed brief for prompt injection; undefined when nothing selected. */
export function buildSkillBrief(_selections: SkillSelection[]): string | undefined {
  return undefined;
}

/** Appends one JSONL entry per selection to .seekforge/skills-usage.jsonl. */
export function logSkillUsage(_workspace: string, _sessionId: string, _selections: SkillSelection[]): void {}

/** Scaffolds .seekforge/skills/<id>/ with skill.json + SKILL.md templates. */
export function createSkillScaffold(_workspace: string, _id: string): string {
  throw new Error("not implemented yet (skills work stream)");
}
