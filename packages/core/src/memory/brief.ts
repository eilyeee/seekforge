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

import { readGlobalMemory, readProjectMemory, readSubdirMemories } from "./store.js";

// Injection budget. Raised from (8 / 800 / 12) as the curated corpus grows so
// more facts can surface — including per-package subdir facts (see the cascade
// merge below). TRADEOFF: every extra bullet/char is injected into EVERY session
// prompt, so this trades per-session token cost for recall. Keep these modest;
// the relevance floor + char budget still bound a large corpus.
const MAX_BULLETS = 12;
/** Total brief size cap, header line included. */
const MAX_CHARS = 1200;

/**
 * When the whole approved-fact set is this small, skip relevance filtering and
 * inject all of it (it fits the char budget anyway). For a handful of curated
 * facts, recall beats filtering — a lexically-missed-but-relevant fact is worse
 * than a little extra context, and this matches how Claude/Codex always load
 * their memory file. The relevance floor only kicks in once memory grows large.
 */
const SMALL_CORPUS = 20;

/**
 * Minimum score for a bullet to be considered relevant. A single generic
 * unigram hit (score 1) is noise; two unigrams, one phrase bigram, or one
 * path token clear the floor.
 */
const RELEVANCE_FLOOR = 2;

/** Bullets of these types are cheap and broadly useful — always included. */
const ALWAYS_INCLUDE_TYPES = new Set(["command", "tech"]);

const STALE_WARNING = "Remembered facts from earlier sessions — may be stale; verify before relying on them.";

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
    // Iterate by code point, not UTF-16 code unit: a supplementary-plane Han
    // char (CJK Ext B) is a surrogate pair, and slicing by code unit would emit
    // orphaned-surrogate "bigrams" that never match. Identical to slice for the
    // common BMP case.
    const cps = [...run];
    for (let i = 0; i + 1 < cps.length; i++) keywords.add(cps[i]! + cps[i + 1]!);
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

/**
 * Where a fact came from. Precedence on identical-line dedup and tie-breaks:
 * root project > subdir package > global. Mapped to a numeric rank below.
 */
type FactSource = "project" | "subdir" | "global";

const SOURCE_RANK: Record<FactSource, number> = { project: 2, subdir: 1, global: 0 };

type ScoredBullet = {
  line: string;
  type: string;
  score: number;
  /** Position within its source file; higher = appended later = newer. */
  index: number;
  /** Origin of the fact; drives precedence (root > subdir > global). */
  source: FactSource;
  /** True only for ROOT project facts — the always-include rule applies to these. */
  isProject: boolean;
};

function parseBullet(line: string): { type: string; text: string } | undefined {
  const match = /^-\s+\[([a-z_]+)\]\s+(.+)$/.exec(line.trim());
  if (!match || match[1] === undefined || match[2] === undefined) return undefined;
  return { type: match[1], text: match[2] };
}

function scoreBullet(haystack: string, keywords: string[], bigrams: string[], pathTokens: string[]): number {
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

/** Re-export so consumers (the search_memory tool) can also tag matches. */
export { ALWAYS_INCLUDE_TYPES, RELEVANCE_FLOOR };

/** A candidate memory bullet from one source, ready for ranking. */
export type MemoryCandidateBullet = {
  /** The full bullet line ("- [type] text"). */
  line: string;
  /** Parsed bullet type ("command", "tech", ...). */
  type: string;
  /**
   * Extra context (e.g. a subdir's relative dir) folded into the scoring
   * haystack so the +4 path-token boost surfaces facts from the package the
   * task references — without altering `line`.
   */
  pathContext?: string;
};

/** A ranked bullet: its candidate fields plus the relevance score. */
export type RankedMemoryBullet = MemoryCandidateBullet & { score: number };

/**
 * Reusable relevance ranking shared by buildMemoryBrief and the search_memory
 * tool. Scores each candidate against the task/query using the same
 * unigram/bigram/path-token model documented at the top of this file, then
 * returns the candidates sorted by score (highest first). Stable for equal
 * scores (input order is preserved). An empty/blank query yields all-zero
 * scores (every candidate is "equally relevant"), so callers can fall back to
 * always-include facts. Never throws.
 */
export function rankMemoryBullets<T extends MemoryCandidateBullet>(
  query: string,
  candidates: T[],
): Array<T & { score: number }> {
  const keywords = taskKeywords(query);
  const bigrams = taskBigrams(query);
  const pathTokens = taskPathTokens(query);
  const scored = candidates.map((c) => {
    const haystack = c.pathContext ? `${c.pathContext} ${c.line}` : c.line;
    return { ...c, score: scoreBullet(haystack.toLowerCase(), keywords, bigrams, pathTokens) };
  });
  // Stable sort by score (highest first); ties keep input order.
  return scored
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.score - a.c.score || a.i - b.i)
    .map((x) => x.c);
}

/** Parse a memory bullet line; exported for reuse by the search_memory tool. */
export function parseMemoryBullet(line: string): { type: string; text: string } | undefined {
  return parseBullet(line);
}

export function buildMemoryBrief(workspace: string, task: string): string | undefined {
  // Merge PROJECT facts with GLOBAL (cross-project) facts. The global file lives
  // under the SeekForge home (~/.seekforge/memory/project.md, overridable via
  // SEEKFORGE_HOME); see store.readGlobalMemory.
  const projectMemory = readProjectMemory(workspace);
  const globalMemory = readGlobalMemory();
  // Subdir cascade: per-package memory files found by a bounded scan under the
  // workspace (see store.readSubdirMemories). Their bullets join the same
  // candidate set; the existing +4 path-token boost surfaces the package whose
  // path the task references, so no per-subdir gating is needed.
  const subdirMemories = readSubdirMemories(workspace);
  if (
    (!projectMemory || projectMemory.trim().length === 0) &&
    (!globalMemory || globalMemory.trim().length === 0) &&
    subdirMemories.length === 0
  ) {
    return undefined;
  }

  const keywords = taskKeywords(task);
  const bigrams = taskBigrams(task);
  const pathTokens = taskPathTokens(task);

  const scoreOf = (haystack: string): number => scoreBullet(haystack.toLowerCase(), keywords, bigrams, pathTokens);

  // Build the candidate bullet set from ALL sources, deduping identical bullets.
  // Sources are collected in precedence order (root project, then subdir, then
  // global) so the first copy of an identical line wins (project > subdir >
  // global). The merged set feeds the same small-corpus + floor logic.
  const all: ScoredBullet[] = [];
  const seen = new Set<string>();
  const collect = (
    memory: string | undefined,
    source: FactSource,
    // Extra path context (a subdir's relative dir) folded into the scoring
    // haystack so the +4 path-token boost surfaces facts from the package the
    // task references — without altering the injected bullet text.
    pathContext = "",
  ): void => {
    if (!memory) return;
    const isProject = source === "project";
    memory.split("\n").forEach((rawLine, index) => {
      const bullet = parseBullet(rawLine);
      if (!bullet) return;
      const line = `- [${bullet.type}] ${bullet.text}`;
      if (seen.has(line)) return; // identical bullet already collected (higher source wins)
      seen.add(line);
      const haystack = pathContext
        ? `${pathContext} [${bullet.type}] ${bullet.text}`
        : `[${bullet.type}] ${bullet.text}`;
      all.push({
        line,
        type: bullet.type,
        score: scoreOf(haystack),
        index,
        source,
        isProject,
      });
    });
  };
  collect(projectMemory, "project");
  for (const sub of subdirMemories) {
    // Normalize the package dir to forward slashes so a "src/login.ts"-style
    // path token in the task can match the package path on any OS.
    collect(sub.content, "subdir", sub.relDir.split(/[\\/]+/).join("/"));
  }
  collect(globalMemory, "global");
  if (all.length === 0) return undefined;

  // Small corpus: include everything (recall > filtering). Larger corpus: apply
  // the relevance floor so weak matches are dropped, not just ranked last.
  //
  // DESIGN: the "always include [command]/[tech]" rule applies to PROJECT facts
  // only. Global facts are included by relevance alone — blanket-including every
  // global command/tech fact would leak cross-project noise into every project.
  const smallCorpus = all.length <= SMALL_CORPUS;
  const selected = smallCorpus
    ? all
    : all.filter((b) => b.score >= RELEVANCE_FLOOR || (b.isProject && ALWAYS_INCLUDE_TYPES.has(b.type)));
  if (selected.length === 0) return undefined;

  // Highest score first; on equal score precedence is root project > subdir >
  // global, then recency (later line in its source file) breaks the remaining tie.
  selected.sort((a, b) => b.score - a.score || SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || b.index - a.index);

  const lines: string[] = [STALE_WARNING];
  let chars = STALE_WARNING.length;
  for (const { line } of selected) {
    // The bullet cap only applies to large corpora; a small set is injected
    // whole (bounded by MAX_CHARS regardless).
    if (!smallCorpus && lines.length - 1 >= MAX_BULLETS) break;
    const cost = line.length + 1; // joining "\n"
    // Skip a bullet that doesn't fit and keep trying shorter ones (they are
    // score-ordered, so `break` here would drop every remaining bullet — and a
    // single oversized top bullet would suppress the whole brief).
    if (chars + cost > MAX_CHARS) continue;
    lines.push(line);
    chars += cost;
  }
  if (lines.length === 1) return undefined; // Header alone is not a brief.
  return lines.join("\n");
}
