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

export type { Skill, SkillEffectiveness, SkillScope, SkillSelection } from "./types.js";
export { BUILTIN_SKILLS } from "./builtins.js";
export {
  loadSkills,
  loadSkillsDetailed,
  loadSkillsDetailedFromDirs,
  loadSkillsFromDirs,
  type SkillDiagnostic,
  type SkillLoadResult,
  type SkillsDir,
  CURRENT_SKILL_API_VERSION,
} from "./load.js";
export { SKILL_ID_RE, resolveSkillsStoreRoot } from "./storage.js";
export { clearSkillSignalCache, selectSkills, type SelectSkillsOptions } from "./select.js";
export { buildSkillBrief, SKILL_BRIEF_MAX_CHARS } from "./brief.js";
export {
  logSkillOutcome,
  logSkillUsage,
  MAX_SKILL_USAGE_BYTES,
  readSkillEffectiveness,
  selectedSkillIdsForSession,
  type SkillOutcome,
} from "./usage.js";
export { createSkillScaffold } from "./scaffold.js";
export {
  removeSkill,
  repairSkills,
  setSkillEnabled,
  type ManageSkillOptions,
  type RemoveSkillResult,
  type RepairSkillsResult,
  type SetSkillEnabledResult,
} from "./manage.js";
export {
  importExternalSkill,
  parseFrontmatterSkill,
  type ImportSkillOptions,
  type ParsedExternalSkill,
} from "./import.js";
