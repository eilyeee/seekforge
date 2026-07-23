import type { SkillSelection } from "./types.js";

/** Hard cap on the injected brief; keeps prompt overhead bounded. */
export const SKILL_BRIEF_MAX_CHARS = 2500;

const FALLBACK_LINES = 20;
const PROCEDURE_HEADINGS = /^(procedure|workflow|steps?|instructions?|步骤|流程|操作步骤)$/i;

/** Procedure section (heading included) or the first 20 lines as fallback. */
function extractProcedure(content: string): string {
  const lines = content.split("\n");
  const start = lines.findIndex((line) => {
    const match = /^#{1,6}\s*(.+?)\s*$/.exec(line.trim());
    return match?.[1] !== undefined && PROCEDURE_HEADINGS.test(match[1]);
  });
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
  const perSkill = Math.max(200, Math.floor(SKILL_BRIEF_MAX_CHARS / selections.length));
  const parts = selections.map(({ skill }) => {
    const header = `## ${skill.id} [${skill.scope}, risk=${skill.risk}]\n${skill.description}\n`;
    const procedure = extractProcedure(skill.content);
    const budget = Math.max(0, perSkill - header.length);
    const clipped =
      procedure.length > budget ? `${procedure.slice(0, Math.max(0, budget - 15))}\n…[truncated]` : procedure;
    return `${header}${clipped}`.trimEnd();
  });
  const brief = parts.join("\n\n");
  return brief.length > SKILL_BRIEF_MAX_CHARS ? `${brief.slice(0, SKILL_BRIEF_MAX_CHARS - 1)}…` : brief;
}
