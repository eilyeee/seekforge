/**
 * Skills module: loading, rule-based selection, brief building, usage log.
 *
 * Layers (docs/11-skills-system.md): project > global > builtin.
 *   builtin   shipped in-package (BUILTIN_SKILLS)
 *   global    ~/.seekforge/skills/<id>/{skill.json,SKILL.md}
 *   project   .seekforge/skills/<id>/{skill.json,SKILL.md}
 *
 * Skills are procedure suggestions only — they never grant permissions.
 */

export type { Skill, SkillScope, SkillSelection } from "./types.js";
export { BUILTIN_SKILLS } from "./builtins.js";
export { loadSkills, loadSkillsFromDirs, type SkillsDir } from "./load.js";
export { selectSkills, type SelectSkillsOptions } from "./select.js";
export { buildSkillBrief, SKILL_BRIEF_MAX_CHARS } from "./brief.js";
export { logSkillUsage } from "./usage.js";
export { createSkillScaffold } from "./scaffold.js";
export {
  removeSkill,
  setSkillEnabled,
  type ManageSkillOptions,
  type RemoveSkillResult,
  type SetSkillEnabledResult,
} from "./manage.js";
export {
  importExternalSkill,
  parseFrontmatterSkill,
  type ImportSkillOptions,
  type ParsedExternalSkill,
} from "./import.js";
