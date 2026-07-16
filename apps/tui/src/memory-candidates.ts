import type { MemoryCandidate } from "@seekforge/core";

/**
 * Pure helpers for the memory-candidate review overlay (`/memory candidates`).
 *
 * Core owns candidate storage (listMemoryCandidates / approveMemoryCandidate /
 * rejectMemoryCandidate) and app.tsx owns the interactive wiring + those core
 * calls. This module owns only the list/selection index math and row
 * formatting, so it stays free of Ink and can be unit-tested in isolation
 * (mirrors backtrack.ts).
 */

/** Where an approved candidate is written: this project or the user-global file. */
export type CandidateScope = "project" | "user";

/** Fields a candidate row needs to render (subset of core's MemoryCandidate). */
export type CandidateRow = Pick<MemoryCandidate, "type" | "content" | "confidence">;

/** Keep only pending candidates (mirrors the desktop MemoryView filter). */
export function pendingCandidates<T extends { status: MemoryCandidate["status"] }>(candidates: readonly T[]): T[] {
  return candidates.filter((c) => c.status === "pending");
}

/** Clamp an index into [0, count); returns 0 when the list is empty. */
export function clampIndex(index: number, count: number): number {
  if (count <= 0) return 0;
  if (index < 0) return 0;
  if (index >= count) return count - 1;
  return index;
}

/** Move a selection index by delta with wraparound; clamps to 0 when empty. */
export function moveCandidateIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  const raw = index + delta;
  return ((raw % count) + count) % count;
}

/**
 * Remove the candidate at `index` (after approve/reject) and return the trimmed
 * list plus a still-valid selection index: clamped to the new last row, or 0
 * when the list becomes empty. Out-of-range indices leave the list untouched.
 */
export function removeCandidateAt<T>(candidates: readonly T[], index: number): { candidates: T[]; index: number } {
  if (index < 0 || index >= candidates.length) {
    return { candidates: candidates.slice(), index: clampIndex(index, candidates.length) };
  }
  const next = candidates.filter((_, i) => i !== index);
  return { candidates: next, index: clampIndex(index, next.length) };
}

/** One-line summary for a candidate row: "[type] content (NN%)". */
export function formatCandidateLine(candidate: CandidateRow): string {
  // Coerce a non-finite confidence (NaN/±Infinity) to 0 so it never renders "(NaN%)".
  const finite = Number.isFinite(candidate.confidence) ? candidate.confidence : 0;
  const clamped = Math.max(0, Math.min(1, finite));
  const pct = Math.round(clamped * 100);
  const text = candidate.content.replace(/\s+/g, " ").trim();
  return `[${candidate.type}] ${text} (${pct}%)`;
}
