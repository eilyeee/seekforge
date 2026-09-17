/**
 * Skills module: loading, rule-based selection, brief building, usage log.
 *
 * Layers (docs/skills.md): project > global > builtin.
 *   builtin   shipped in-package (BUILTIN_SKILLS)
 *   global    plugin roots, ~/.claude/skills (opt-in), ~/.seekforge/skills
 *   project   .claude/skills, .seekforge/skills
 * Each skill is <id>/SKILL.md (frontmatter optional) with an optional skill.json.
 *
 * Skills are procedure suggestions. Only a builtin or user-scope skill's
 * `allowed-tools` may pre-approve tools while it is active (invocation.ts).
 */

export type { Skill, SkillEffectiveness, SkillScope, SkillSelection, SkillSource } from "./types.js";
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
  configureSkillSources,
  type SkillSourceOptions,
} from "./load.js";
export { SKILL_ID_RE, resolveClaudeSkillsRoot, resolveSkillsStoreRoot } from "./storage.js";
export { clearSkillSignalCache, selectSkills, skillPathsApply, type SelectSkillsOptions } from "./select.js";
export { buildSkillListing, invocableSkills, SKILL_LISTING_MAX_CHARS } from "./listing.js";
export {
  createSkillSession,
  expandSkillBody,
  INVOKE_SKILL_TOOL,
  skillMayPreApprove,
  splitSkillArguments,
  type SkillActivation,
  type SkillForkRequest,
  type SkillSession,
  type SkillSessionHost,
} from "./invocation.js";
export { mapToolName, translateToolRules, type TranslatedToolRules } from "./tool-rules.js";
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
export { skillSupplyChainReport } from "./supply-chain.js";
export type { SkillSupplyChainEntry } from "@seekforge/shared";
