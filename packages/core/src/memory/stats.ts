/**
 * memoryStats: read-only extraction-quality measurement over a workspace's
 * memory state. Pure and tolerant of missing files (everything zeros when the
 * workspace has no memory yet). Never throws.
 *
 * It joins three on-disk sources:
 *   - project.md         approved fact bullets ("[type] content")
 *   - candidates.jsonl   candidate lifecycle (pending/approved/rejected) + the
 *                        model `confidence` and the `sourceSessionId` provenance
 *   - fact-meta.json     per-fact usage counters (uses / lastUsedAt)
 *
 * Provenance: a candidate is AUTO-EXTRACTED when its sourceSessionId is a real
 * session id; the direct channel (direct.ts addMemoryFact) stamps the marker
 * "manual" (its default sourceSessionId), so DIRECT_SOURCE_MARKER === "manual".
 */

import { listProjectFacts } from "./direct.js";
import { readCandidates, readFactMeta } from "./store.js";

/**
 * sourceSessionId used by the direct channel (direct.ts addMemoryFact default).
 * Anything else on an approved candidate means it came from auto-extraction.
 */
export const DIRECT_SOURCE_MARKER = "manual";

export type MemoryStats = {
  /** Total approved fact bullets currently in project.md. */
  totalApprovedFacts: number;
  /** Approved facts traced to an auto-extraction session (real sourceSessionId). */
  autoExtractedFacts: number;
  /** Approved facts added via the direct channel (sourceSessionId === "manual"). */
  directAddedFacts: number;
  /**
   * Fraction (0..1) of approved facts that have been USED at least once
   * (uses > 0 in fact-meta). The extraction "precision proxy". 0 when there
   * are no approved facts.
   */
  usedFraction: number;
  /**
   * Candidate rejection rate (0..1): rejected / (approved + rejected + pending).
   * 0 when there are no candidates at all.
   */
  rejectionRate: number;
  /**
   * Average model confidence of approved facts that ended up USED vs UNUSED —
   * the empirical confidence-calibration signal. null when the bucket is empty.
   */
  avgConfidenceUsed: number | null;
  avgConfidenceUnused: number | null;
  /** Candidate status counts. */
  pending: number;
  approved: number;
  rejected: number;
};

const EMPTY: MemoryStats = {
  totalApprovedFacts: 0,
  autoExtractedFacts: 0,
  directAddedFacts: 0,
  usedFraction: 0,
  rejectionRate: 0,
  avgConfidenceUsed: null,
  avgConfidenceUnused: null,
  pending: 0,
  approved: 0,
  rejected: 0,
};

/** Bullet body ("[type] content") — the fact-meta key — from a "- [type] ..." line. */
function bulletBody(line: string): string {
  return line.replace(/^-\s*/, "").trim();
}

/**
 * Reads workspace memory state and computes extraction-quality stats.
 * Read-only and best-effort: any unexpected failure returns all-zeros.
 */
export function memoryStats(workspace: string): MemoryStats {
  try {
    const facts = listProjectFacts(workspace); // approved bullets in project.md
    const candidates = readCandidates(workspace);
    const meta = readFactMeta(workspace);

    // Candidate status counts (drive the rejection rate).
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    for (const c of candidates) {
      if (c.status === "pending") pending++;
      else if (c.status === "approved") approved++;
      else if (c.status === "rejected") rejected++;
    }
    const totalCandidates = pending + approved + rejected;
    const rejectionRate = totalCandidates > 0 ? rejected / totalCandidates : 0;

    // Index approved candidates by content for provenance + confidence joins.
    // An approved candidate's content matches the project.md bullet content.
    const approvedByContent = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      if (c.status === "approved" && !approvedByContent.has(c.content)) {
        approvedByContent.set(c.content, c);
      }
    }

    const totalApprovedFacts = facts.length;
    let autoExtractedFacts = 0;
    let directAddedFacts = 0;
    let usedCount = 0;
    // Confidence buckets keyed on whether the fact was used.
    let usedConfSum = 0;
    let usedConfN = 0;
    let unusedConfSum = 0;
    let unusedConfN = 0;

    for (const fact of facts) {
      const body = bulletBody(fact.line);
      // body is "[type] content"; the candidate content is the part after "[type] ".
      const content = body.replace(/^\[[a-z_]+\]\s*/, "");
      const cand = approvedByContent.get(content);

      // Provenance via the matched approved candidate (audit row).
      if (cand) {
        if (cand.sourceSessionId === DIRECT_SOURCE_MARKER) directAddedFacts++;
        else autoExtractedFacts++;
      }

      // Usage (precision proxy) via fact-meta, keyed by bullet body.
      const used = (meta[body]?.uses ?? 0) > 0;
      if (used) usedCount++;

      // Confidence calibration: only facts with a known model confidence (a
      // matched candidate) contribute to the used/unused averages.
      if (cand) {
        if (used) {
          usedConfSum += cand.confidence;
          usedConfN++;
        } else {
          unusedConfSum += cand.confidence;
          unusedConfN++;
        }
      }
    }

    return {
      totalApprovedFacts,
      autoExtractedFacts,
      directAddedFacts,
      usedFraction: totalApprovedFacts > 0 ? usedCount / totalApprovedFacts : 0,
      rejectionRate,
      avgConfidenceUsed: usedConfN > 0 ? usedConfSum / usedConfN : null,
      avgConfidenceUnused: unusedConfN > 0 ? unusedConfSum / unusedConfN : null,
      pending,
      approved,
      rejected,
    };
  } catch {
    return { ...EMPTY };
  }
}
