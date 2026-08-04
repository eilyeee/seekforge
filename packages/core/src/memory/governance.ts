import type { MemoryGovernanceFact, MemoryGovernanceReport } from "@seekforge/shared";
import { listProjectFacts } from "./direct.js";
import { readCandidates, readFactMeta } from "./store.js";
// Deciding whether two facts disagree is the same question here and while
// building the brief; one implementation means the report and the warning the
// model actually sees can never drift apart.
import { findConflicts, similarity } from "./conflict.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Produces read-only quality signals; it never removes or rewrites memory. */
export function memoryGovernance(workspace: string, now = Date.now()): MemoryGovernanceReport {
  const candidates = readCandidates(workspace);
  const approvedByContent = new Map(
    candidates
      .filter((candidate) => candidate.status === "approved")
      .map((candidate) => [candidate.content, candidate]),
  );
  const meta = readFactMeta(workspace);
  const facts = listProjectFacts(workspace)
    .slice(0, 2_048)
    .map(({ index, line }): MemoryGovernanceFact => {
      const body = line.replace(/^-\s*/, "").trim();
      const match = /^\[([^\]]+)\]\s*(.*)$/.exec(body);
      const type = match?.[1] ?? null;
      const content = match?.[2] ?? body;
      const activity = meta[body];
      const candidate = approvedByContent.get(content);
      const addedAt = activity ? Date.parse(activity.addedAt) : Number.NaN;
      const ageDays = Number.isFinite(addedAt) ? Math.max(0, (now - addedAt) / DAY_MS) : 0;
      const decayScore = Math.exp((-Math.LN2 * ageDays) / 90);
      const uses = activity?.uses ?? 0;
      const exposures = activity?.exposures ?? 0;
      const retrievals = activity?.retrievals ?? 0;
      const engagement = Math.min(1, (uses * 2 + retrievals + Math.min(exposures, 5) * 0.1) / 6);
      const confidence = candidate?.confidence;
      const qualityScore = decayScore * 0.35 + engagement * 0.4 + (confidence ?? 0.5) * 0.25;
      return {
        index,
        type,
        content,
        ...(candidate ? { sourceSessionId: candidate.sourceSessionId, confidence: candidate.confidence } : {}),
        ageDays,
        decayScore,
        qualityScore,
        uses,
        exposures,
        retrievals,
        stale: ageDays >= 90 && uses === 0 && retrievals === 0,
      };
    });
  const duplicateGroups: number[][] = [];
  const grouped = new Set<number>();
  const contradictionCandidates: Array<{ left: number; right: number }> = [];
  // Pair analysis is bounded independently from the displayed fact list.
  const compared = facts.slice(0, 512);
  for (let left = 0; left < compared.length; left++) {
    for (let right = left + 1; right < compared.length; right++) {
      const a = compared[left]!;
      const b = compared[right]!;
      if (a.type !== b.type) continue;
      const score = similarity(a.content, b.content);
      if (score >= 0.7 && !grouped.has(a.index) && !grouped.has(b.index)) {
        duplicateGroups.push([a.index, b.index]);
        grouped.add(a.index);
        grouped.add(b.index);
      }
    }
  }
  // Contradictions are decided over the whole compared set, not pair by pair:
  // two facts differing only by a number are a replacement, but a dozen of them
  // are a numbered list.
  for (const pair of findConflicts(compared.map((fact) => ({ key: fact.type ?? "", text: fact.content })))) {
    contradictionCandidates.push({ left: compared[pair.left]!.index, right: compared[pair.right]!.index });
  }
  const exposedFacts = facts.filter((fact) => fact.exposures > 0);
  const retrievedFacts = facts.filter((fact) => fact.retrievals > 0);
  return {
    generatedAt: new Date(now).toISOString(),
    facts,
    duplicateGroups,
    contradictionCandidates,
    retrieval: {
      exposureToUseRate:
        exposedFacts.length > 0 ? exposedFacts.filter((fact) => fact.uses > 0).length / exposedFacts.length : 0,
      retrievalToUseRate:
        retrievedFacts.length > 0 ? retrievedFacts.filter((fact) => fact.uses > 0).length / retrievedFacts.length : 0,
      staleFacts: facts.filter((fact) => fact.stale).length,
    },
  };
}
