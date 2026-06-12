/**
 * buildMemoryBrief: task-relevant digest of approved project memory for
 * prompt injection.
 *
 * Relevance scoring (no LLM call):
 *   +1 per task unigram / CJK bigram found in the fact,
 *   +2 per adjacent-word (latin) bigram phrase found in the fact,
 *   +4 per path/filename token shared between task and fact.
 * Facts below the relevance floor are dropped entirely — when nothing in
 * memory clears the floor, NO brief is injected (silence beats noise).
 * Ties are broken by recency: later project.md lines (newer facts) win.
 */

import { readProjectMemory } from "./store.js";

const MAX_BULLETS = 8;
/** Total brief size cap, header line included. */
const MAX_CHARS = 800;

/**
 * Minimum score for a bullet to be considered relevant. A single generic
 * unigram hit (score 1) is noise; two unigrams, one phrase bigram, or one
 * path token clear the floor.
 */
const RELEVANCE_FLOOR = 2;

/** Bullets of these types are cheap and broadly useful — always included. */
const ALWAYS_INCLUDE_TYPES = new Set(["command", "tech"]);

const STALE_WARNING =
  "Remembered facts from earlier sessions — may be stale; verify before relying on them.";

const CJK_RUN = /\p{Script=Han}+/gu;
const HAS_CJK = /\p{Script=Han}/u;
/** Slash paths (src/a/b.ts) and bare filenames with an extension (vite.config.ts). */
const PATH_TOKEN = /[\p{L}\p{N}_.-]*\/[\p{L}\p{N}_/.-]+|\b[\p{L}\p{N}_-]+\.[a-z]{1,6}\b/giu;

/**
 * Keywords for relevance scoring: latin/word tokens of length >= 3 plus
 * CJK bigrams (tasks are often Chinese, where whitespace tokenization
 * does not work).
 */
export function taskKeywords(task: string): string[] {
  const lower = task.toLowerCase();
  const keywords = new Set<string>();
  for (const word of lower.split(/[^\p{L}\p{N}_]+/u)) {
    if (word.length >= 3) keywords.add(word);
  }
  for (const run of lower.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) {
      keywords.add(run.slice(i, i + 2));
    }
  }
  return [...keywords];
}

/** Adjacent latin word pairs ("login validation") for the phrase boost. */
export function taskBigrams(task: string): string[] {
  const words = task
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length >= 3 && !HAS_CJK.test(w));
  const bigrams = new Set<string>();
  for (let i = 0; i + 1 < words.length; i++) {
    bigrams.add(`${words[i]} ${words[i + 1]}`);
  }
  return [...bigrams];
}

/** Path-ish tokens (anything with a slash, or a filename.ext) in the task. */
export function taskPathTokens(task: string): string[] {
  const tokens = new Set<string>();
  for (const match of task.toLowerCase().match(PATH_TOKEN) ?? []) {
    // Strip surrounding punctuation a sentence may attach ("src/a.ts.").
    const cleaned = match.replace(/^[./]+|[.,;:]+$/g, "");
    if (cleaned.length >= 3 && /[/.]/.test(cleaned)) tokens.add(cleaned);
  }
  return [...tokens];
}

type ScoredBullet = {
  line: string;
  type: string;
  score: number;
  /** Position in project.md; higher = appended later = newer. */
  index: number;
};

function parseBullet(line: string): { type: string; text: string } | undefined {
  const match = /^-\s+\[([a-z_]+)\]\s+(.+)$/.exec(line.trim());
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return { type: match[1], text: match[2] };
}

function scoreBullet(
  haystack: string,
  keywords: string[],
  bigrams: string[],
  pathTokens: string[],
): number {
  let score = 0;
  for (const kw of keywords) {
    if (haystack.includes(kw)) score += 1;
  }
  for (const bg of bigrams) {
    if (haystack.includes(bg)) score += 2;
  }
  for (const pt of pathTokens) {
    if (haystack.includes(pt)) score += 4;
  }
  return score;
}

export function buildMemoryBrief(workspace: string, task: string): string | undefined {
  const memory = readProjectMemory(workspace);
  if (!memory || memory.trim().length === 0) return undefined;

  const keywords = taskKeywords(task);
  const bigrams = taskBigrams(task);
  const pathTokens = taskPathTokens(task);

  const scored: ScoredBullet[] = [];
  memory.split("\n").forEach((rawLine, index) => {
    const bullet = parseBullet(rawLine);
    if (!bullet) return;
    const haystack = `[${bullet.type}] ${bullet.text}`.toLowerCase();
    const score = scoreBullet(haystack, keywords, bigrams, pathTokens);
    // Relevance floor: weak matches are dropped, not ranked last.
    if (score >= RELEVANCE_FLOOR || ALWAYS_INCLUDE_TYPES.has(bullet.type)) {
      scored.push({ line: `- [${bullet.type}] ${bullet.text}`, type: bullet.type, score, index });
    }
  });
  if (scored.length === 0) return undefined;

  // Highest score first; recency (later project.md line) breaks ties.
  scored.sort((a, b) => b.score - a.score || b.index - a.index);

  const lines: string[] = [STALE_WARNING];
  let chars = STALE_WARNING.length;
  for (const { line } of scored) {
    if (lines.length - 1 >= MAX_BULLETS) break;
    const cost = line.length + 1; // joining "\n"
    if (chars + cost > MAX_CHARS) break;
    lines.push(line);
    chars += cost;
  }
  if (lines.length === 1) return undefined; // Header alone is not a brief.
  return lines.join("\n");
}
