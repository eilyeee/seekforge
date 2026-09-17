/**
 * /skills — the rows behind the interactive panel (manage/toggles.ts).
 *
 * Core's Skill type (packages/core/src/skills/types.ts) carries id, scope
 * ("builtin" | "global" | "project"), description and enabled, but
 * loadSkills() filters disabled skills out entirely, so the formatter accepts
 * a small structural shape instead and loadSkillsWithStatus() rebuilds the
 * disabled flag: a builtin id absent from the loaded set was disabled via an
 * override marker (see core skills/manage.ts).
 */
import {
  BUILTIN_SKILLS,
  loadSkills,
  loadSkillsDetailed,
  readSkillEffectiveness,
  type PluginContributions,
} from "@seekforge/core";

/** Structural row for the /skills list; mapped from core's Skill. */
export type SkillRow = {
  id: string;
  description?: string;
  scope?: string;
  disabled?: boolean;
  selections?: number;
  successRate?: number;
  /** `user-invocable: false`: the model may load it, the user gets no /skill: command. */
  userInvocable?: false;
};

/** Collapses whitespace runs and caps to `max` chars with an ellipsis. */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Loads skills for the workspace and annotates disabled builtins. Core's
 * loadSkills() resolves builtin < global < project layers and drops disabled
 * skills, so any BUILTIN_SKILLS id missing from its result was disabled by an
 * override marker; it is re-added here with disabled:true so /skills can show
 * it. Disabled non-builtin skills have no surviving record and stay hidden.
 */
export function loadSkillsWithStatus(workspace: string, contributions?: PluginContributions): SkillRow[] {
  const loaded = loadSkills(workspace, contributions);
  const stats = new Map(readSkillEffectiveness(workspace).map((row) => [row.skillId, row]));
  const loadedIds = new Set(loaded.map((s) => s.id));
  const rows: SkillRow[] = loaded.map((s) => ({
    id: s.id,
    description: s.description,
    scope: s.scope,
    disabled: false,
    ...(s.userInvocable === false ? { userInvocable: false as const } : {}),
    ...(stats.get(s.id)?.selections !== undefined ? { selections: stats.get(s.id)!.selections } : {}),
    ...(stats.get(s.id)?.successRate !== undefined ? { successRate: stats.get(s.id)!.successRate } : {}),
  }));
  for (const builtin of BUILTIN_SKILLS) {
    if (loadedIds.has(builtin.id)) continue;
    rows.push({
      id: builtin.id,
      description: builtin.description,
      scope: "builtin",
      disabled: true,
    });
  }
  return rows;
}

/** Actionable warnings for malformed or unsafe skill installations. */
export function loadSkillDiagnosticLines(workspace: string, contributions?: PluginContributions): string[] {
  return loadSkillsDetailed(workspace, contributions).diagnostics.map(
    (diagnostic) =>
      `warning [${diagnostic.code}] ${diagnostic.id ?? diagnostic.path}: ${collapse(diagnostic.message, 100)}`,
  );
}
