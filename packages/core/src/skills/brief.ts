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

const PART_SEPARATOR = "\n\n";

/** One skill's entry: what it is, plus as much procedure as its share allows. */
function renderPart(skill: SkillSelection["skill"], perSkill: number): string {
  const header = `## ${skill.id} [${skill.scope}, risk=${skill.risk}]\n${skill.description}\n`;
  const procedure = extractProcedure(skill.content);
  const budget = Math.max(0, perSkill - header.length);
  // A cut procedure says where the rest is. Silently truncating the one thing a
  // skill exists to deliver left the model following half a procedure with no
  // way to know it, or to ask for the other half.
  const marker = `\n…[truncated — call read_skill("${skill.id}") for the full procedure]`;
  const clipped =
    procedure.length > budget ? `${procedure.slice(0, Math.max(0, budget - marker.length))}${marker}` : procedure;
  return `${header}${clipped}`.trimEnd();
}

/** Compressed brief for prompt injection; undefined when nothing selected. */
export function buildSkillBrief(selections: SkillSelection[]): string | undefined {
  if (selections.length === 0) return undefined;
  // The separators are part of the budget: without counting them the parts sum
  // to just over the cap, and the clip lands inside the last entry.
  const separators = PART_SEPARATOR.length * Math.max(0, selections.length - 1);
  const perSkill = Math.max(200, Math.floor((SKILL_BRIEF_MAX_CHARS - separators) / selections.length));
  // Whole entries only. Clipping the joined string at the cap could land inside
  // the last entry's "call read_skill(…)" marker — cutting off the affordance
  // exactly when the budget is tightest and the excerpt least complete. A skill
  // that does not fit is left out, which the model can act on; a mutilated one
  // is not.
  const parts: string[] = [];
  let used = 0;
  for (const { skill } of selections) {
    const part = renderPart(skill, perSkill);
    const cost = part.length + (parts.length > 0 ? PART_SEPARATOR.length : 0);
    if (used + cost > SKILL_BRIEF_MAX_CHARS) break;
    parts.push(part);
    used += cost;
  }
  return parts.length > 0 ? parts.join(PART_SEPARATOR) : undefined;
}
