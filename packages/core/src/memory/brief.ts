/**
 * buildMemoryBrief: task-relevant digest of approved project memory for
 * prompt injection.
 */

import { readProjectMemory } from "./store.js";

const MAX_BULLETS = 12;
const MAX_CHARS = 1500;

/** Bullets of these types are cheap and broadly useful — always included. */
const ALWAYS_INCLUDE_TYPES = new Set(["command", "tech"]);

const CJK_RUN = /\p{Script=Han}+/gu;

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

type ScoredBullet = {
  line: string;
  type: string;
  score: number;
};

function parseBullet(line: string): { type: string; text: string } | undefined {
  const match = /^-\s+\[([a-z_]+)\]\s+(.+)$/.exec(line.trim());
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return { type: match[1], text: match[2] };
}

export function buildMemoryBrief(workspace: string, task: string): string | undefined {
  const memory = readProjectMemory(workspace);
  if (!memory || memory.trim().length === 0) return undefined;

  const keywords = taskKeywords(task);
  const scored: ScoredBullet[] = [];
  for (const rawLine of memory.split("\n")) {
    const bullet = parseBullet(rawLine);
    if (!bullet) continue;
    const haystack = `[${bullet.type}] ${bullet.text}`.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (haystack.includes(kw)) score++;
    }
    if (score > 0 || ALWAYS_INCLUDE_TYPES.has(bullet.type)) {
      scored.push({ line: `- [${bullet.type}] ${bullet.text}`, type: bullet.type, score });
    }
  }
  if (scored.length === 0) return undefined;

  // Highest score first; stable sort keeps original order within ties.
  scored.sort((a, b) => b.score - a.score);

  const lines: string[] = [];
  let chars = 0;
  for (const { line } of scored) {
    if (lines.length >= MAX_BULLETS) break;
    const cost = line.length + (lines.length > 0 ? 1 : 0); // joining "\n"
    if (chars + cost > MAX_CHARS) break;
    lines.push(line);
    chars += cost;
  }
  if (lines.length === 0) return undefined;
  return lines.join("\n");
}
