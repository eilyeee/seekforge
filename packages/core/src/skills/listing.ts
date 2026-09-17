import { compareByCodePoints } from "@seekforge/shared";
import { skillPathsApply } from "./select.js";
import type { Skill } from "./types.js";

/**
 * The skill listing: what the model may load with `invoke_skill`.
 *
 * It rides in the system prompt, so every provider call pays for it; the
 * budget is spent on as much of each description as fits, and a skill that
 * cannot fit even as a bare name is counted rather than silently missing.
 */

/** Total listing budget (characters). */
export const SKILL_LISTING_MAX_CHARS = 8_000;
/** Claude Code's per-skill cap on description + when_to_use. */
export const SKILL_LISTING_ENTRY_MAX_CHARS = 1_536;
/** Successively tighter per-entry caps tried when the listing overflows. */
const ENTRY_CAPS = [SKILL_LISTING_ENTRY_MAX_CHARS, 400, 160, 0] as const;

const SCOPE_ORDER: Record<Skill["scope"], number> = { project: 0, global: 1, builtin: 2 };

/** Skills the model may invoke in this workspace. */
export function invocableSkills(skills: readonly Skill[], workspace: string | undefined): Skill[] {
  return skills
    .filter((skill) => skill.enabled && skill.disableModelInvocation !== true && skill.risk !== "high")
    .filter((skill) => skillPathsApply(skill, workspace))
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || compareByCodePoints(a.id, b.id));
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return max <= 1 ? "" : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function renderEntry(skill: Skill, cap: number, preloaded: boolean): string {
  const about = [skill.description, skill.whenToUse].filter((part) => part && part.trim() !== "").join(" ");
  const summary = cap > 0 ? clip(about, cap) : "";
  const tags = [
    skill.argumentHint ? `args: ${clip(skill.argumentHint, 80)}` : "",
    skill.context === "fork" ? "runs in a subagent" : "",
    preloaded ? "excerpt already above" : "",
  ].filter(Boolean);
  return `- ${skill.id}${summary ? `: ${summary}` : ""}${tags.length > 0 ? ` (${tags.join("; ")})` : ""}`;
}

/**
 * One line per invocable skill, or undefined when there is none. Entries keep
 * their order; when the whole list overflows `maxChars`, every entry's summary
 * is shortened before any entry is dropped.
 */
export function buildSkillListing(
  skills: readonly Skill[],
  options: { maxChars?: number; preloaded?: ReadonlySet<string> } = {},
): string | undefined {
  if (skills.length === 0) return undefined;
  const budget =
    options.maxChars !== undefined && Number.isSafeInteger(options.maxChars) && options.maxChars > 0
      ? options.maxChars
      : SKILL_LISTING_MAX_CHARS;
  const preloaded = options.preloaded ?? new Set<string>();
  for (const cap of ENTRY_CAPS) {
    const lines = skills.map((skill) => renderEntry(skill, cap, preloaded.has(skill.id)));
    const text = lines.join("\n");
    if (text.length <= budget) return text;
    if (cap !== 0) continue;
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const remaining = skills.length - kept.length - 1;
      const note = remaining > 0 ? `\n- … ${remaining} more skill(s) not listed` : "";
      if (used + line.length + 1 + note.length > budget) break;
      kept.push(line);
      used += line.length + 1;
    }
    const omitted = skills.length - kept.length;
    if (kept.length === 0) return undefined;
    return omitted > 0 ? `${kept.join("\n")}\n- … ${omitted} more skill(s) not listed` : kept.join("\n");
  }
  return undefined;
}
