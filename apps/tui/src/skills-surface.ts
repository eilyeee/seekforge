/**
 * /skills — listing surface.
 *
 * Core's Skill type (packages/core/src/skills/types.ts) carries id, scope
 * ("builtin" | "global" | "project"), description and enabled, but
 * loadSkills() filters disabled skills out entirely, so the formatter accepts
 * a small structural shape instead and loadSkillsWithStatus() rebuilds the
 * disabled flag: a builtin id absent from the loaded set was disabled via an
 * override marker (see core skills/manage.ts).
 */
import { BUILTIN_SKILLS, loadSkills } from "@seekforge/core";

/** Structural row for the /skills list; mapped from core's Skill. */
export type SkillRow = {
  id: string;
  description?: string;
  scope?: string;
  disabled?: boolean;
};

/** Collapses whitespace runs and caps to `max` chars with an ellipsis. */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * One line per skill: "id  (scope)  description…", with "[builtin]" for
 * builtin scope and "[disabled]" when disabled. Empty input yields a hint
 * line pointing at `seekforge skill import`.
 */
export function formatSkillLines(skills: ReadonlyArray<SkillRow>): string[] {
  if (skills.length === 0) {
    return ["no skills installed — seekforge skill import <path> adds one"];
  }
  return skills.map((s) => {
    const scope = s.scope ? `  (${s.scope})` : "";
    const desc = s.description ? `  ${collapse(s.description, 60)}` : "";
    const builtin = s.scope === "builtin" ? "  [builtin]" : "";
    const disabled = s.disabled ? "  [disabled]" : "";
    return `${s.id}${scope}${desc}${builtin}${disabled}`;
  });
}

/**
 * Loads skills for the workspace and annotates disabled builtins. Core's
 * loadSkills() resolves builtin < global < project layers and drops disabled
 * skills, so any BUILTIN_SKILLS id missing from its result was disabled by an
 * override marker; it is re-added here with disabled:true so /skills can show
 * it. Disabled non-builtin skills have no surviving record and stay hidden.
 */
export function loadSkillsWithStatus(workspace: string): SkillRow[] {
  const loaded = loadSkills(workspace);
  const loadedIds = new Set(loaded.map((s) => s.id));
  const rows: SkillRow[] = loaded.map((s) => ({
    id: s.id,
    description: s.description,
    scope: s.scope,
    disabled: false,
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
