/**
 * Deterministic project-memory compaction: collapses exact-duplicate bullets
 * and merges near-duplicates (same [type] + high word overlap), keeping the
 * longer survivor. No model call — auditable and reproducible (docs/09).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  projectMemoryPath,
  readFactMeta,
  readRawProjectMemory,
  reconcileFactMeta,
  withMemoryTransaction,
} from "./store.js";
import { writeFileAtomic } from "../util/fs.js";

/** Jaccard threshold above which two same-type bullets are "near duplicates". */
const NEAR_DUP_JACCARD = 0.8;

export type CompactMerge = { kept: string; dropped: string };

export type CompactResult = {
  /** Bullet count before compaction. */
  before: number;
  /** Bullet count after compaction. */
  after: number;
  /** Bullet lines removed as exact duplicates. */
  removed: string[];
  /** Near-duplicate merges (longer kept, shorter dropped). */
  merged: CompactMerge[];
  /** Stale bullets moved to project-archive.md (old + never injected). */
  archived: string[];
};

type Bullet = { raw: string; type: string | undefined; words: Set<string> };

/** Extracts a leading `[type]` tag from a bullet's content, if present. */
function parseBullet(raw: string): Bullet {
  const body = raw.replace(/^-\s*/, "");
  const typeMatch = /^\[([^\]]+)\]/.exec(body);
  const type = typeMatch ? typeMatch[1] : undefined;
  const text = typeMatch ? body.slice(typeMatch[0].length) : body;
  const lower = text.toLowerCase();
  // Scripts without word boundaries (Han, Hangul, Kana, Cyrillic, Greek, Arabic,
  // …) are split into single characters; latin/digit runs stay as words.
  // Otherwise different phrasings of the same fact never overlap — and, worse,
  // two *distinct* facts in such a script both tokenize to the empty set and
  // would be treated as duplicates (see jaccard). Match any letter that isn't
  // ASCII a–z as a single-char token.
  const words = new Set<string>([
    ...(lower.match(/[^\P{Letter}a-z]/gu) ?? []),
    ...lower.split(/[^a-z0-9]+/i).filter((w) => w.length > 0),
  ]);
  return { raw, type, words };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  // Two token-less bullets (e.g. pure punctuation/emoji) are NOT assumed
  // duplicates — treating them as identical silently dropped distinct facts.
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Computes a compaction of project.md's bullet lines. Pure: returns the result
 * and the rewritten file content without touching disk. Survivors keep their
 * original relative order; non-bullet lines (header, blanks) are preserved.
 */
type Survivor = { lineNo: number; bullet: Bullet; replacement?: string };

export function computeCompaction(raw: string): { result: CompactResult; content: string } {
  const lines = raw.split("\n");
  // Index the bullet lines; keep everything else fixed in place.
  const entries: { lineNo: number; bullet: Bullet }[] = [];
  lines.forEach((line, lineNo) => {
    if (line.trim().startsWith("- ")) {
      entries.push({ lineNo, bullet: parseBullet(line.trim()) });
    }
  });

  const removed: string[] = [];
  const merged: CompactMerge[] = [];
  const dropLineNos = new Set<number>();
  const survivors: Survivor[] = [];
  const seenExact = new Set<string>();

  for (const entry of entries) {
    const key = entry.bullet.raw.trim();

    // Exact duplicate of an earlier survivor → drop.
    if (seenExact.has(key)) {
      removed.push(entry.bullet.raw);
      dropLineNos.add(entry.lineNo);
      continue;
    }

    // Near-duplicate of an earlier survivor of the same type → keep longer.
    let mergedAway = false;
    for (const survivor of survivors) {
      const survBullet = survivor.replacement ? parseBullet(survivor.replacement) : survivor.bullet;
      if (survBullet.type !== entry.bullet.type) continue;
      if (jaccard(survBullet.words, entry.bullet.words) < NEAR_DUP_JACCARD) continue;

      const survText = survBullet.raw;
      const entryText = entry.bullet.raw;
      if (entryText.length > survText.length) {
        // New one is longer: upgrade the survivor's content in its earlier slot.
        merged.push({ kept: entryText, dropped: survText });
        survivor.replacement = entryText;
      } else {
        // Existing survivor is longer (or equal): drop the new one.
        merged.push({ kept: survText, dropped: entryText });
      }
      dropLineNos.add(entry.lineNo);
      mergedAway = true;
      break;
    }
    if (mergedAway) continue;

    survivors.push({ lineNo: entry.lineNo, bullet: entry.bullet });
    seenExact.add(key);
  }

  // Rebuild file: drop removed/merged-away lines; substitute any survivor whose
  // content was upgraded by a longer near-duplicate.
  const replacementByLine = new Map<number, string>();
  for (const s of survivors) {
    if (s.replacement !== undefined) replacementByLine.set(s.lineNo, s.replacement);
  }
  const outLines: string[] = [];
  lines.forEach((line, lineNo) => {
    if (dropLineNos.has(lineNo)) return;
    const rep = replacementByLine.get(lineNo);
    outLines.push(rep ?? line);
  });

  const result: CompactResult = {
    before: entries.length,
    after: entries.length - removed.length - merged.length,
    removed,
    merged,
    archived: [],
  };
  return { result, content: outLines.join("\n") };
}

export type CompactOptions = {
  dryRun?: boolean;
  /**
   * Archive bullets first added more than this many days ago that have NEVER
   * been injected into a session (uses === 0, per the fact-meta sidecar) to
   * project-archive.md. Facts without metadata are left untouched (we can't tell
   * their age). Omit to skip pruning.
   */
  pruneUnusedDays?: number;
};

/**
 * Identifies stale bullets in `content`: those whose fact-meta says addedAt is
 * older than `days` AND uses === 0. Returns the kept content + archived lines.
 */
function pruneUnused(
  content: string,
  meta: Record<string, { addedAt: string; uses: number }>,
  days: number,
): { content: string; archived: string[] } {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const archived: string[] = [];
  const kept = content.split("\n").filter((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) return true;
    const key = trimmed.replace(/^-\s*/, "");
    const m = meta[key];
    if (!m || m.uses > 0) return true; // unknown age or used → keep
    const added = Date.parse(m.addedAt);
    // Corrupt/non-ISO timestamp parses to NaN; NaN >= cutoff is false, which
    // would silently archive a fact of unknown age. Treat unparseable as "keep".
    if (Number.isNaN(added) || added >= cutoff) return true; // recent/unknown → keep
    archived.push(trimmed);
    return false;
  });
  return { content: kept.join("\n"), archived };
}

/**
 * Compacts a project's project.md (dedupe + near-dup merge). With
 * `pruneUnusedDays`, also archives stale, never-used facts. When dryRun, reports
 * the plan without writing. Header / non-bullet lines are preserved verbatim.
 */
function compactProjectMemoryUnlocked(workspace: string, opts: CompactOptions): CompactResult {
  // Raw (unexpanded): compaction rewrites project.md, so it must operate on and
  // preserve the literal file — never the @import-inlined form.
  const raw = readRawProjectMemory(workspace);
  if (raw === undefined) {
    return { before: 0, after: 0, removed: [], merged: [], archived: [] };
  }
  const { result, content } = computeCompaction(raw);

  let finalContent = content;
  if (opts.pruneUnusedDays !== undefined && opts.pruneUnusedDays >= 0) {
    const pruned = pruneUnused(content, readFactMeta(workspace), opts.pruneUnusedDays);
    finalContent = pruned.content;
    result.archived = pruned.archived;
    result.after -= pruned.archived.length;
  }

  if (!opts.dryRun && result.archived.length > 0) {
    const archiveFile = path.join(path.dirname(projectMemoryPath(workspace)), "project-archive.md");
    const block = `${result.archived.join("\n")}\n`;
    try {
      fs.appendFileSync(archiveFile, block, "utf8");
    } catch {
      // Preserve facts in project.md unless their archive write succeeded.
      finalContent = content;
      result.after += result.archived.length;
      result.archived = [];
    }
  }
  const changed = result.removed.length > 0 || result.merged.length > 0 || result.archived.length > 0;
  if (!opts.dryRun && changed) {
    writeFileAtomic(projectMemoryPath(workspace), finalContent);
    // Drop fact-meta entries orphaned by the rewrite (dropped dup/merge/prune).
    reconcileFactMeta(workspace, finalContent);
  }
  return result;
}

export function compactProjectMemory(workspace: string, opts: CompactOptions = {}): CompactResult {
  return withMemoryTransaction(workspace, () => compactProjectMemoryUnlocked(workspace, opts));
}
