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

const truncationMarker = (skillId: string): string =>
  `\n…[truncated — call read_skill("${skillId}") for the full procedure]`;

/**
 * Max-min fair allocation. An even split starves a long procedure while a short
 * one leaves its share unspent, so the same cap bought less procedure than it
 * paid for: with three builtins selected the even share is 832 characters, and
 * `simplify` needs 740 of it while `bugfix` needs 1104. Water-filling hands every
 * skill only what it can use and re-offers the remainder to the ones still short.
 */
function fairShares(needs: readonly number[], total: number): number[] {
  const shares = new Array<number>(needs.length).fill(0);
  let remaining = total;
  let open = needs.map((_, index) => index);
  while (open.length > 0 && remaining > 0) {
    const each = Math.floor(remaining / open.length);
    if (each <= 0) break;
    const next: number[] = [];
    let consumed = 0;
    for (const index of open) {
      const give = Math.min(each, (needs[index] ?? 0) - (shares[index] ?? 0));
      shares[index] = (shares[index] ?? 0) + give;
      consumed += give;
      if ((shares[index] ?? 0) < (needs[index] ?? 0)) next.push(index);
    }
    if (consumed === 0) break;
    remaining -= consumed;
    open = next;
  }
  return shares;
}

/** `1.` / `2)` / `-` / `*` — the shapes these procedures use for a step. */
const LIST_ITEM_START = /^\s*(?:\d+[.)]|[-*+])\s/;

/**
 * Clip to the last complete *step*, not the last complete line. These procedures
 * are numbered lists whose steps wrap across lines, so a line-boundary cut still
 * lands inside step 4 — and half of step 4 reads exactly like all of step 4, which
 * the model has no way to detect. Dropping the partial step is the honest cut;
 * the marker tells it where the rest is.
 */
function clipProcedure(procedure: string, budget: number, skillId: string): string {
  if (procedure.length <= budget) return procedure;
  const marker = truncationMarker(skillId);
  const room = budget - marker.length;
  if (room <= 0) return "";
  const head = procedure.slice(0, room);
  const lastBreak = head.lastIndexOf("\n");
  const lines = (lastBreak > 0 ? head.slice(0, lastBreak) : head).split("\n");
  // The kept text ends mid-step unless the very next original line starts a new
  // one. Walk back over the partial step, but never past the last complete one:
  // a single step longer than the whole budget is still better shown clipped
  // than replaced by nothing.
  const consumed = lines.join("\n").length;
  const nextLine = procedure.slice(consumed).replace(/^\n/, "").split("\n", 1)[0] ?? "";
  if (!LIST_ITEM_START.test(nextLine)) {
    let lastItem = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (LIST_ITEM_START.test(lines[index] ?? "")) {
        lastItem = index;
        break;
      }
    }
    if (lastItem > 0) lines.length = lastItem;
  }
  const body = lines.join("\n").trimEnd();
  return body.length > 0 ? `${body}${marker}` : "";
}

type BriefEntry = { id: string; header: string; procedure: string };

/**
 * Compressed brief for prompt injection; undefined when nothing selected.
 *
 * `maxChars` exists so an evaluation can measure the budget rather than assume
 * it: reallocation cannot fit three full builtin procedures into 2,500
 * characters, and widening the cap costs tokens on every single call.
 */
export function buildSkillBrief(selections: SkillSelection[], maxChars = SKILL_BRIEF_MAX_CHARS): string | undefined {
  if (selections.length === 0) return undefined;
  const cap =
    Number.isSafeInteger(maxChars) && maxChars > 0
      ? Math.min(maxChars, 4 * SKILL_BRIEF_MAX_CHARS)
      : SKILL_BRIEF_MAX_CHARS;
  // The separators are part of the budget: without counting them the parts sum
  // to just over the cap, and the clip lands inside the last entry.
  const separators = PART_SEPARATOR.length * Math.max(0, selections.length - 1);
  const total = cap - separators;
  let entries: BriefEntry[] = selections.map(({ skill }) => ({
    id: skill.id,
    header: `## ${skill.id} [${skill.scope}, risk=${skill.risk}]\n${skill.description}\n`,
    procedure: extractProcedure(skill.content),
  }));
  // A share too small to carry the skill's own header buys nothing, so drop that
  // entry and re-offer its share instead of emitting a stub that costs tokens
  // and says nothing. Dropping can free enough to satisfy a survivor, so repeat.
  let shares = fairShares(
    entries.map((entry) => entry.header.length + entry.procedure.length),
    total,
  );
  for (;;) {
    const kept = entries.filter((entry, index) => (shares[index] ?? 0) >= entry.header.length);
    if (kept.length === entries.length) break;
    entries = kept;
    if (entries.length === 0) return undefined;
    shares = fairShares(
      entries.map((entry) => entry.header.length + entry.procedure.length),
      total,
    );
  }
  const render = (entry: BriefEntry, share: number): string =>
    `${entry.header}${clipProcedure(entry.procedure, Math.max(0, share - entry.header.length), entry.id)}`.trimEnd();
  // Cutting at a step boundary gives back whatever the partial step would have
  // cost, so a single allocation pass leaves the budget underspent. Re-offer the
  // slack to the entries that are still truncated until nothing more fits — this
  // is what buys back a whole extra step rather than just a tidier cut.
  const needs = entries.map((entry) => entry.header.length + entry.procedure.length);
  for (let round = 0; round < 4; round++) {
    const lengths = entries.map((entry, index) => render(entry, shares[index] ?? 0).length);
    const slack = total - lengths.reduce((sum, length) => sum + length, 0);
    const short = entries.map((_, index) => index).filter((index) => (lengths[index] ?? 0) < (needs[index] ?? 0));
    if (slack <= 0 || short.length === 0) break;
    // Rebuild the shares from what was actually rendered, never from the previous
    // shares: an entry that clipped below its share would otherwise have its
    // unspent remainder counted twice, pushing the totals past the cap and
    // silently dropping the last entry.
    const extra = fairShares(
      short.map((index) => (needs[index] ?? 0) - (lengths[index] ?? 0)),
      slack,
    );
    const next = [...lengths];
    short.forEach((index, position) => {
      next[index] = (lengths[index] ?? 0) + (extra[position] ?? 0);
    });
    if (next.every((value, index) => value === shares[index])) break;
    shares = next;
  }
  // Fair rounds spread the last remainder too thinly for anyone to reach their
  // next step boundary, so it stays unspent. Hand it to one entry at a time
  // instead: a whole step delivered beats a few characters shared three ways.
  for (const [index, entry] of entries.entries()) {
    const lengths = entries.map((candidate, at) => render(candidate, shares[at] ?? 0).length);
    const slack = total - lengths.reduce((sum, length) => sum + length, 0);
    if (slack <= 0) break;
    if ((lengths[index] ?? 0) >= (needs[index] ?? 0)) continue;
    const grown = render(entry, (lengths[index] ?? 0) + slack).length;
    if (grown > (lengths[index] ?? 0)) shares[index] = (lengths[index] ?? 0) + slack;
  }
  // Whole entries only. Clipping the joined string at the cap could land inside
  // the last entry's "call read_skill(…)" marker — cutting off the affordance
  // exactly when the budget is tightest and the excerpt least complete. A skill
  // that does not fit is left out, which the model can act on; a mutilated one
  // is not.
  const parts: string[] = [];
  let used = 0;
  for (const [index, entry] of entries.entries()) {
    const part = render(entry, shares[index] ?? 0);
    const cost = part.length + (parts.length > 0 ? PART_SEPARATOR.length : 0);
    if (used + cost > cap) break;
    parts.push(part);
    used += cost;
  }
  return parts.length > 0 ? parts.join(PART_SEPARATOR) : undefined;
}
