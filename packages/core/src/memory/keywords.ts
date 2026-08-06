import { addUsage, ZERO_USAGE, type TokenUsage } from "@seekforge/shared";
import type { ChatProvider } from "../provider/index.js";
import { INJECTION_PATTERN, sanitizeKeywords } from "./extract.js";
import { listProjectFacts } from "./direct.js";
import { readFactMeta, recordFactAdded } from "./store.js";

/**
 * Backfilling bilingual retrieval keywords.
 *
 * Keywords reach a fact one way: the extractor asks for them in the call it was
 * already making. That leaves three kinds of fact without any — every fact
 * remembered before keywords existed, every fact added by hand (`# fact`,
 * `/remember`, `memory add`, which involve no model at all), and every fact
 * whose extraction predates a provider that answered the question well.
 *
 * Those facts are not broken; they score exactly as they did before. But the
 * gap is invisible and permanent unless something can close it, and the only
 * thing that can is a model that reads the fact. This is that: an explicit,
 * user-initiated pass over the facts that lack keywords, batched into as few
 * requests as possible.
 *
 * SCOPE: whichever root it is given. A workspace holds a project's facts; the
 * SeekForge home holds the global ones beside their own project.md, with the
 * same sidecar and the same lease — so `backfillFactKeywords(provider,
 * seekforgeHome())` backfills cross-project memory with no special case.
 */

/** Facts per request. Small enough that one bad response costs little. */
const BATCH_SIZE = 20;
/** Hard ceiling on facts touched by one call, regardless of `limit`. */
const MAX_FACTS = 500;

const SYSTEM_PROMPT = [
  "You write retrieval keywords for a project's remembered facts.",
  "",
  "For each numbered fact, return 3 to 8 short search terms, IN BOTH ENGLISH",
  "AND CHINESE — the words someone would use to look this fact up in either",
  "language, including the obvious translation of its key nouns and verbs.",
  "This exists so a question asked in one language can find a fact written in",
  "the other.",
  "",
  "Terms only, never a sentence. Derive them from the FACT — do not invent",
  "topics it does not mention. Return an empty array for a fact that is a bare",
  "command or path with nothing to translate.",
  "",
  "Return STRICT JSON inside a ```json fence, keyed by the fact's number:",
  "",
  "```json",
  '{"1": ["term", "术语"], "2": []}',
  "```",
  "",
  "Output nothing outside the fence.",
].join("\n");

export type BackfillResult = {
  /** Facts in project.md that had no keywords when this started. */
  missing: number;
  /** Facts this call gave keywords to. */
  updated: number;
  /** Requests made. */
  batches: number;
  /**
   * What the requests cost. Every model call in this system belongs to usage
   * accounting — a command that spends money silently is one whose bill arrives
   * with no way to attribute it. Zeroed when nothing was requested.
   */
  usage: TokenUsage;
};

/** Bullet body ("[type] content") — the key fact-meta is stored under. */
function bulletBody(line: string): string {
  return line.replace(/^-\s*/, "").trim();
}

/** Parse one batch response: { "<index>": string[] }. Tolerant of junk. */
function parseKeywordResponse(content: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const fence = /```json\s*\n([\s\S]*?)```/.exec(content);
  if (!fence || fence[1] === undefined) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fence[1]);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 1) continue;
    const keywords = sanitizeKeywords(value);
    if (keywords.length > 0) out.set(index, keywords);
  }
  return out;
}

/**
 * The project facts that have no keywords yet, as bullets. Pure and
 * provider-free, so "how many would this touch?" never needs a model — and so
 * the backfill cannot be reached with a fake provider just to count.
 */
export function factsMissingKeywords(workspace: string): string[] {
  const meta = readFactMeta(workspace);
  return listProjectFacts(workspace)
    .filter((fact) => {
      const entry = meta[bulletBody(fact.line)];
      // A fact whose text reads like an instruction never gained keywords from
      // the extractor either; asking a model to expand it is the one thing not
      // to do with it.
      return (!entry || entry.keywords === undefined) && !INJECTION_PATTERN.test(bulletBody(fact.line));
    })
    .map((fact) => fact.line);
}

/**
 * Give keywords to the project facts that have none. Never throws for a model
 * or parse failure — a batch that comes back unusable leaves its facts exactly
 * as they were, and the count says so.
 */
export async function backfillFactKeywords(
  provider: ChatProvider,
  workspace: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<BackfillResult> {
  const missing = factsMissingKeywords(workspace).map((line) => ({ body: bulletBody(line), line }));
  const limit = Math.min(opts.limit ?? MAX_FACTS, MAX_FACTS);
  const targets = missing.slice(0, limit);
  if (targets.length === 0) return { missing: missing.length, updated: 0, batches: 0, usage: ZERO_USAGE };

  let updated = 0;
  let batches = 0;
  let usage: TokenUsage = ZERO_USAGE;
  for (let start = 0; start < targets.length; start += BATCH_SIZE) {
    if (opts.signal?.aborted) break;
    const batch = targets.slice(start, start + BATCH_SIZE);
    const numbered = batch.map((fact, i) => `${i + 1}. ${fact.body}`).join("\n");
    batches += 1;
    let content: string;
    try {
      const response = await provider.chat({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: numbered },
        ],
        temperature: 0,
        maxTokens: 2048,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      content = response.content;
      // Counted even when the response turns out to be unparseable: it was
      // billed either way, and a cost that only appears on success is a cost
      // that hides exactly when something went wrong.
      if (response.usage) usage = addUsage(usage, response.usage);
    } catch {
      // One failed batch must not abandon the batches that already succeeded.
      continue;
    }
    for (const [index, keywords] of parseKeywordResponse(content)) {
      const fact = batch[index - 1];
      if (!fact) continue;
      recordFactAdded(workspace, fact.line, keywords);
      updated += 1;
    }
  }
  return { missing: missing.length, updated, batches, usage };
}
