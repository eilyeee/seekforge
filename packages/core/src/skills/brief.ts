import type { SkillSelection } from "./types.js";

/** Hard cap on the injected brief; keeps prompt overhead bounded. */
export const SKILL_BRIEF_MAX_CHARS = 2500;

const FALLBACK_LINES = 20;

/** Procedure section (heading included) or the first 20 lines as fallback. */
function extractProcedure(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s*procedure\s*$/i.test(line.trim()));
  if (start === -1) return lines.slice(0, FALLBACK_LINES).join("\n").trimEnd();
  const section: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i > start && /^#{1,6}\s/.test(line)) break;
    section.push(line);
  }
  return section.join("\n").trimEnd();
}

/** Compressed brief for prompt injection; undefined when nothing selected. */
export function buildSkillBrief(selections: SkillSelection[]): string | undefined {
  if (selections.length === 0) return undefined;
  const parts = selections.map(
    ({ skill }) => `## ${skill.id}\n${skill.description}\n${extractProcedure(skill.content)}`,
  );
  const brief = parts.join("\n\n");
  return brief.length > SKILL_BRIEF_MAX_CHARS ? brief.slice(0, SKILL_BRIEF_MAX_CHARS) : brief;
}
