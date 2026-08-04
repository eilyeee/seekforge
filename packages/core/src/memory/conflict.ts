/**
 * When two remembered facts disagree.
 *
 * Memory is append-only and human-gated, so nothing removes the fact a later
 * one replaced: "the dev server runs on 7373" stays next to "the dev server
 * runs on 8080". Both then get injected, and the model is quietly told two
 * incompatible things about the same subject — which is worse than remembering
 * neither, because it looks like knowledge.
 *
 * Detection is deliberately lexical and cheap: this runs while building the
 * brief on every session start, and a wrong answer here only ever adds a
 * warning, never removes a fact.
 */

const NEGATION_WORDS = ["not", "no", "never", "disable", "disabled", "avoid", "without", "dont", "doesnt"];
const NEGATION_CJK = ["不要", "禁止", "不应", "不能", "不可", "无需", "别用", "勿"];
const NEGATION =
  /(?:\b(?:not|no|never|disable|disabled|avoid|without|don't|doesn't)\b|不要|禁止|不应|不能|不可|无需|别用|勿)/iu;

const HAS_CJK = /\p{Script=Han}/u;

/** Bare numbers, versions, ports, sizes — what a replaced fact usually differs by. */
const VALUE_TOKEN = /\d+(?:\.\d+)*/g;

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}

/** Trim a plural so "installs" and "install" are the same claim. Narrow on purpose. */
function stem(word: string): string {
  return word.length >= 5 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/**
 * The claim a sentence makes, with the negation removed.
 *
 * Stripping the negation before comparing is the point: "use pnpm" and "do not
 * use pnpm" are the SAME claim with opposite polarity, yet leaving the negation
 * in makes them look less alike than two unrelated sentences. The more
 * explicitly a fact contradicts another, the less similar a naive comparison
 * finds them — exactly backwards.
 */
function claimTokens(value: string): Set<string> {
  let text = normalize(value);
  // Removed without leaving a gap: a space here would split the remaining CJK
  // run into pieces, and then one side would be compared as words while the
  // other was compared as characters — which is how a sentence and its own
  // negation ended up with zero overlap.
  for (const marker of NEGATION_CJK) text = text.split(marker).join("");
  const words = text
    .split(" ")
    .filter(Boolean)
    .map(stem)
    .filter((word) => !NEGATION_WORDS.includes(word));
  // Whitespace tokenization says nothing about Chinese or Japanese, so anything
  // containing Han is compared by character instead. The choice depends on the
  // script, never on how many tokens happened to survive — both sides have to
  // be measured the same way to be comparable at all.
  if (HAS_CJK.test(text)) return new Set(Array.from(words.join("")));
  return new Set(words);
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Jaccard overlap of what the two sentences claim, ignoring polarity, 0..1. */
export function similarity(left: string, right: string): number {
  return overlap(claimTokens(left), claimTokens(right));
}

export function negated(value: string): boolean {
  return NEGATION.test(value);
}

function values(text: string): string[] {
  return text.match(VALUE_TOKEN) ?? [];
}

/** The sentence with its numbers removed — what it says apart from the value it carries. */
function template(text: string): Set<string> {
  return claimTokens(text.replace(VALUE_TOKEN, " "));
}

/**
 * How alike two sentences must be before a disagreement between them is worth
 * reporting. The value form is stricter because it has no polarity flip to
 * anchor on: only a claim that is otherwise the same sentence can be said to
 * disagree merely by carrying a different number.
 */
export const NEGATION_SIMILARITY = 0.55;
export const VALUE_SIMILARITY = 0.7;

/**
 * Two facts about the same subject that cannot both be true.
 *
 * Replacement happens two ways. One fact negates what the other asserts ("use
 * pnpm" / "do not use pnpm"), or the same claim carries a different value ("the
 * default port is 7373" / "… is 8080") — the second being what an outdated fact
 * usually looks like, and what a negation-only check misses entirely.
 */
export function contradicts(left: string, right: string): boolean {
  if (negated(left) !== negated(right) && similarity(left, right) >= NEGATION_SIMILARITY) return true;
  const a = values(left);
  const b = values(right);
  // Equal multisets are agreement, and a fact that merely adds a number
  // ("port 7373" / "port 7373 by default") must not disagree with itself.
  if (a.length === 0 || b.length === 0 || a.join(",") === b.join(",")) return false;
  return overlap(template(left), template(right)) >= VALUE_SIMILARITY;
}

/** A fact to compare, and the group it may only be compared within (its type). */
export type ConflictCandidate = { key?: string; text: string };

/** Positions in the input array of two facts that cannot both be true. */
export type ConflictPair = { left: number; right: number };

/** Bounded so an enormous memory file cannot turn this into a quadratic scan. */
const MAX_COMPARED = 512;

/** Sorted template tokens — the claim a fact makes with its values removed. */
function templateSignature(text: string): string {
  return [...template(text)].sort().join(" ");
}

/**
 * Which facts in a set disagree.
 *
 * The value form needs the whole set, not a pair, to be judged at all. Two
 * facts that differ only by a number are a replacement; THREE are a list —
 * "step 1", "step 2", "step 3" say nothing contradictory, and a pairwise test
 * cannot tell them apart from a port that changed. Grouping by the claim first
 * makes the difference visible: a group of two is a disagreement, a group of
 * many is an enumeration.
 *
 * The negation form stays pairwise, since a list of items paired with their own
 * negations is not something that happens by accident.
 */
export function findConflicts(candidates: ConflictCandidate[]): ConflictPair[] {
  const compared = candidates.slice(0, MAX_COMPARED);
  const pairs: ConflictPair[] = [];
  for (let left = 0; left < compared.length; left++) {
    for (let right = left + 1; right < compared.length; right++) {
      const a = compared[left]!;
      const b = compared[right]!;
      if (a.key !== b.key) continue;
      if (negated(a.text) !== negated(b.text) && similarity(a.text, b.text) >= NEGATION_SIMILARITY) {
        pairs.push({ left, right });
      }
    }
  }

  const byClaim = new Map<string, number[]>();
  for (let i = 0; i < compared.length; i++) {
    const item = compared[i]!;
    if (values(item.text).length === 0) continue;
    const signature = `${item.key ?? ""}\u0000${templateSignature(item.text)}`;
    byClaim.set(signature, [...(byClaim.get(signature) ?? []), i]);
  }
  for (const members of byClaim.values()) {
    // Exactly two, saying the same thing with different numbers: one of them
    // replaced the other and nothing removed the old one.
    if (members.length !== 2) continue;
    const [left, right] = members as [number, number];
    if (values(compared[left]!.text).join(",") === values(compared[right]!.text).join(",")) continue;
    if (overlap(template(compared[left]!.text), template(compared[right]!.text)) < VALUE_SIMILARITY) continue;
    pairs.push({ left, right });
  }
  return pairs;
}
