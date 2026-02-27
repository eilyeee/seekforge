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
