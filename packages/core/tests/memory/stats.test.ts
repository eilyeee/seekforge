import { describe, expect, it } from "vitest";
import {
  addMemoryFact,
  approveMemoryCandidate,
  memoryStats,
  recordFactExposure,
  recordFactRetrieval,
  recordFactUse,
} from "../../src/memory/index.js";
import { DIRECT_SOURCE_MARKER } from "../../src/memory/stats.js";
import { makeCandidate, makeWorkspace, writeCandidatesRaw, writeProjectMemory } from "./helpers.js";

describe("memoryStats", () => {
  it("returns all-zero stats for an empty workspace (no files)", () => {
    const ws = makeWorkspace();
    const s = memoryStats(ws);
    expect(s).toEqual({
      totalApprovedFacts: 0,
      autoExtractedFacts: 0,
      directAddedFacts: 0,
      usedFraction: 0,
      exposedFraction: 0,
      retrievalCount: 0,
      rejectionRate: 0,
      avgConfidenceUsed: null,
      avgConfidenceUnused: null,
      pending: 0,
      approved: 0,
      rejected: 0,
    });
  });

  it("separates passive exposure from deliberate retrieval", () => {
    const ws = makeWorkspace();
    addMemoryFact(ws, { content: "fact one", type: "tech" });
    recordFactExposure(ws, "- [tech] fact one");
    let stats = memoryStats(ws);
    expect(stats.exposedFraction).toBe(1);
    expect(stats.usedFraction).toBe(0);
    expect(stats.retrievalCount).toBe(0);

    recordFactRetrieval(ws, "- [tech] fact one");
    stats = memoryStats(ws);
    expect(stats.usedFraction).toBe(1);
    expect(stats.retrievalCount).toBe(1);
  });

  it("distinguishes auto-extracted from direct-added approved facts", () => {
    const ws = makeWorkspace();
    // Auto-extracted candidate (real session id) seeded first (writeCandidatesRaw
    // overwrites the file, so it must precede the appending direct add).
    writeCandidatesRaw(
      ws,
      `${JSON.stringify(
        makeCandidate({ id: "mc-sessX-1", content: "auto fact", type: "tech", sourceSessionId: "sessX" }),
      )}\n`,
    );
    approveMemoryCandidate(ws, "mc-sessX-1");
    // Direct-added fact (marker source) appends its own approved candidate.
    addMemoryFact(ws, { content: "direct fact", type: "convention" });

    const s = memoryStats(ws);
    expect(s.totalApprovedFacts).toBe(2);
    expect(s.autoExtractedFacts).toBe(1);
    expect(s.directAddedFacts).toBe(1);
    // direct fact uses the "manual" marker.
    expect(DIRECT_SOURCE_MARKER).toBe("manual");
  });

  it("computes used fraction (precision proxy) and rejection rate", () => {
    const ws = makeWorkspace();
    // Two approved candidates -> two project.md facts.
    writeCandidatesRaw(
      ws,
      [
        JSON.stringify(makeCandidate({ id: "mc-a-1", content: "fact one", type: "tech", sourceSessionId: "a", confidence: 0.9 })),
        JSON.stringify(makeCandidate({ id: "mc-a-2", content: "fact two", type: "tech", sourceSessionId: "a", confidence: 0.4 })),
        JSON.stringify(makeCandidate({ id: "mc-a-3", content: "rej", type: "tech", sourceSessionId: "a", status: "rejected" })),
        JSON.stringify(makeCandidate({ id: "mc-a-4", content: "pend", type: "tech", sourceSessionId: "a", status: "pending" })),
      ].map((l) => `${l}\n`).join(""),
    );
    approveMemoryCandidate(ws, "mc-a-1");
    approveMemoryCandidate(ws, "mc-a-2");

    // Use only fact one (records uses>0 in fact-meta, keyed by bullet body).
    recordFactUse(ws, "- [tech] fact one");

    const s = memoryStats(ws);
    expect(s.totalApprovedFacts).toBe(2);
    expect(s.usedFraction).toBeCloseTo(0.5, 5);
    // candidates: approved 2, rejected 1, pending 1 -> rejection 1/4.
    expect(s.approved).toBe(2);
    expect(s.rejected).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.rejectionRate).toBeCloseTo(0.25, 5);
  });

  it("reports avg confidence of used vs unused facts (calibration signal)", () => {
    const ws = makeWorkspace();
    writeCandidatesRaw(
      ws,
      [
        JSON.stringify(makeCandidate({ id: "mc-c-1", content: "used fact", type: "tech", sourceSessionId: "c", confidence: 0.9 })),
        JSON.stringify(makeCandidate({ id: "mc-c-2", content: "unused fact", type: "tech", sourceSessionId: "c", confidence: 0.3 })),
      ].map((l) => `${l}\n`).join(""),
    );
    approveMemoryCandidate(ws, "mc-c-1");
    approveMemoryCandidate(ws, "mc-c-2");
    recordFactUse(ws, "- [tech] used fact");

    const s = memoryStats(ws);
    expect(s.avgConfidenceUsed).toBeCloseTo(0.9, 5);
    expect(s.avgConfidenceUnused).toBeCloseTo(0.3, 5);
  });

  it("counts project.md facts without a matching candidate but leaves provenance unattributed", () => {
    const ws = makeWorkspace();
    // Hand-written project.md fact, no candidate audit row.
    writeProjectMemory(ws, "# Project Memory\n- [convention] orphan fact\n");
    const s = memoryStats(ws);
    expect(s.totalApprovedFacts).toBe(1);
    expect(s.autoExtractedFacts).toBe(0);
    expect(s.directAddedFacts).toBe(0);
    expect(s.usedFraction).toBe(0);
  });
});
