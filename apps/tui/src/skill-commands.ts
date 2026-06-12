/**
 * Skills as invocable slash commands: every ENABLED skill becomes a
 * `/skill:<id>` palette entry whose invocation wraps the skill's SKILL.md
 * content into a task prompt for the agent.
 *
 * Content resolution: skills-surface.ts's SkillRow deliberately carries no
 * `content` (it is a listing surface and skills-surface.ts is owned by the
 * /skills feature, not this module), so attachSkillContent() re-loads the
 * full skills via core's loadSkills() and joins on id. loadSkills() resolves
 * the same builtin < global < project layering loadSkillsWithStatus() is
 * built on, so the join is exact for every enabled skill; disabled skills
 * have no content (they are never invocable anyway).
 */
import { loadSkills } from "@seekforge/core";
import type { SkillRow } from "./skills-surface.js";

/** A /skills row optionally enriched with the full SKILL.md content. */
export type SkillCommandRow = SkillRow & { content?: string };

/** CommandSpec-compatible palette row (group is always "tools"). */
export type SkillCommandSpec = {
  name: string;
  args?: string;
  summary: string;
  group: "tools";
};

const COMMAND_PREFIX = "skill:";
const SUMMARY_CAP = 60;
const DEFAULT_TASK =
  "Apply this skill to the current context — ask via ask_user if the target is unclear.";

/** Sanitizes a skill id into a command-safe name: lowercase [a-z0-9-]. */
function sanitizeId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Collapses whitespace runs and caps to `max` chars with an ellipsis. */
function collapse(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Joins /skills rows with the full skill content from core's loadSkills().
 * Rows without a loaded counterpart (disabled builtins) stay content-less.
 */
export function attachSkillContent(
  workspace: string,
  rows: readonly SkillRow[],
): SkillCommandRow[] {
  const contentById = new Map(loadSkills(workspace).map((s) => [s.id, s.content]));
  return rows.map((row) => {
    const content = contentById.get(row.id);
    return content === undefined ? { ...row } : { ...row, content };
  });
}

/**
 * One CommandSpec-compatible row per ENABLED skill: name "skill:<id>"
 * (sanitized), args hint "[task]", summary "(skill) " + description capped
 * at 60 chars. Disabled skills are excluded (nothing to invoke), as are
 * skills whose id sanitizes to nothing.
 */
export function skillCommandSpecs(skills: readonly SkillRow[]): SkillCommandSpec[] {
  const out: SkillCommandSpec[] = [];
  for (const skill of skills) {
    if (skill.disabled) continue;
    const id = sanitizeId(skill.id);
    if (id === "") continue;
    out.push({
      name: `${COMMAND_PREFIX}${id}`,
      args: "[task]",
      summary: `(skill) ${collapse(skill.description ?? skill.id, SUMMARY_CAP)}`,
      group: "tools",
    });
  }
  return out;
}

/**
 * Builds the agent task for an invoked skill: the SKILL.md content wrapped
 * in <skill> tags plus the user's task text (or a self-targeting default
 * when invoked bare). Falls back to the description when content is absent.
 */
export function expandSkillCommand(skill: SkillCommandRow, args: string): string {
  const content = (skill.content ?? skill.description ?? skill.id).trim();
  const task = args.trim() || DEFAULT_TASK;
  return `Apply the following skill/procedure to this task.\n\n<skill>\n${content}\n</skill>\n\nTask: ${task}`;
}

/**
 * Resolves a typed command name ("skill:<id>", no leading slash) back to its
 * skill. Matches against the sanitized id — the same form skillCommandSpecs
 * advertises — and never returns disabled skills. Null when not a skill
 * command or no enabled skill matches.
 */
export function findSkillByCommand(
  skills: readonly SkillCommandRow[],
  name: string,
): SkillCommandRow | null {
  if (!name.startsWith(COMMAND_PREFIX)) return null;
  const id = name.slice(COMMAND_PREFIX.length);
  if (id === "") return null;
  return skills.find((s) => !s.disabled && sanitizeId(s.id) === id) ?? null;
}
