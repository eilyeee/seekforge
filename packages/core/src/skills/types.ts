export type SkillScope = "builtin" | "global" | "project";

/** Where a skill's definition was read from. */
export type SkillSource = {
  /** `skill.json` beside SKILL.md, or SKILL.md frontmatter alone. */
  format: "skill.json" | "frontmatter";
  /** `.seekforge/skills`, `.claude/skills`, or an enabled plugin's root. */
  root: "seekforge" | "claude" | "plugin";
  /** The contributing plugin's directory (`${CLAUDE_PLUGIN_ROOT}`), for plugin skills. */
  pluginRoot?: string;
};

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
  /**
   * Directory the skill was loaded from. Present for on-disk skills, absent
   * for built-ins and plugin contributions, which have no files beside them.
   * `read_skill` needs it to reach anything the skill ships next to SKILL.md,
   * and it is the sandbox root for that read.
   */
  dir?: string;
  /** Absent for built-ins. */
  source?: SkillSource;
  /** When the model should reach for it; shown beside the description. */
  whenToUse?: string;
  /** Placeholder shown when a user or the model supplies arguments. */
  argumentHint?: string;
  /** Named arguments, bound in order to `$<name>` in the body. */
  argumentNames?: string[];
  /**
   * Tool rules pre-approved while the skill is active. Honored only for
   * builtin and user-scope (incl. approved plugin) skills — see
   * docs/security-model.md; a project skill may restrict, never grant.
   */
  allowedTools?: string[];
  /** Tool rules denied while the skill is active, at every scope. */
  disallowedTools?: string[];
  /** Model to switch to while the skill runs, where the host can. */
  model?: string;
  /** Reasoning effort requested by the skill; informational on hosts that cannot switch it. */
  effort?: string;
  /** "fork" runs the skill in a subagent and returns its report. */
  context?: "inline" | "fork";
  /** Subagent id for `context: fork`. */
  agent?: string;
  /** The model may not load it with invoke_skill, and lexical selection skips it. */
  disableModelInvocation?: boolean;
  /** False hides it from slash menus; the model may still invoke it. Default true. */
  userInvocable?: boolean;
  /** Globs; the skill is offered only when a workspace file matches one. */
  paths?: string[];
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
