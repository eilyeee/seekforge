export type SkillScope = "builtin" | "global" | "project";

export type Skill = {
  /** Metadata contract version. Legacy files without it load as version 1. */
  apiVersion?: 1;
  id: string;
  scope: SkillScope;
  name: string;
  description: string;
  tags: string[];
  /** Substrings matched against the task text (case-insensitive). */
  triggers: string[];
  /** Matching terms that veto automatic selection. */
  negativeTriggers?: string[];
  /** Coarse task categories such as bugfix, test, docs, or security. */
  taskTypes?: string[];
  appliesTo?: {
    languages?: string[];
    frameworks?: string[];
    filePatterns?: string[];
  };
  priority: number;
  enabled: boolean;
  risk: "low" | "medium" | "high";
  /** Skills that must be injected before this skill. */
  dependsOn?: string[];
  /** Mutually-exclusive skills; the higher-ranked skill wins. */
  conflictsWith?: string[];
  /** Stable orchestration order after dependency resolution. */
  order?: number;
  /** Full SKILL.md content. */
  content: string;
};

export type SkillSelection = {
  skill: Skill;
  score: number;
  reason: string;
  /** Bounded historical outcome adjustment applied to the base score. */
  feedbackAdjustment?: number;
};

export type SkillEffectiveness = {
  skillId: string;
  selections: number;
  completedOutcomes: number;
  successes: number;
  successRate?: number;
  averageToolCalls?: number;
  averageTurns?: number;
  averageCostUsd?: number;
  /** Conservative score adjustment in [-0.75, 0.75]. */
  learnedAdjustment: number;
};
