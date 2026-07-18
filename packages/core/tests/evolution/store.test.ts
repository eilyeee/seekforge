import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendEvolutionProposals,
  listEvolutionProposals,
  readEvolutionProposal,
  readEvolutionProposals,
  setEvolutionProposalStatus,
} from "../../src/evolution/index.js";
import { makeProposal, makeWorkspace, readProposalsRaw, writeProposalsRaw } from "./helpers.js";

describe("evolution store", () => {
  it("returns an empty list when no proposals file exists", () => {
    const ws = makeWorkspace();
    expect(listEvolutionProposals(ws)).toEqual([]);
  });

  it("appends proposals and lists them newest first", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal({ id: "ep-sess1-1" }), makeProposal({ id: "ep-sess1-2" })]);
    expect(readEvolutionProposals(ws).map((p) => p.id)).toEqual(["ep-sess1-1", "ep-sess1-2"]);
    expect(listEvolutionProposals(ws).map((p) => p.id)).toEqual(["ep-sess1-2", "ep-sess1-1"]);
  });

  it("refuses proposal directories symlinked outside the workspace", () => {
    const ws = makeWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "seekforge-evolution-outside-"));
    mkdirSync(join(ws, ".seekforge"), { recursive: true });
    symlinkSync(outside, join(ws, ".seekforge", "evolution"));

    expect(() => appendEvolutionProposals(ws, [makeProposal()])).toThrow(/escapes the workspace/);
    expect(() => readFileSync(join(outside, "proposals.jsonl"), "utf8")).toThrow();
  });

  it("skips corrupt and invalid lines", () => {
    const ws = makeWorkspace();
    writeProposalsRaw(
      ws,
      [
        JSON.stringify(makeProposal({ id: "ep-sess1-1" })),
        "{broken json",
        JSON.stringify({ id: "ep-x", not: "a proposal" }),
        JSON.stringify(makeProposal({ id: "ep-sess1-2" })),
      ].join("\n") + "\n",
    );
    expect(readEvolutionProposals(ws).map((p) => p.id)).toEqual(["ep-sess1-1", "ep-sess1-2"]);
  });

  it("reads a single proposal and throws on unknown ids", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    expect(readEvolutionProposal(ws, "ep-sess1-1").title).toBe("Run typecheck after edits");
    expect(() => readEvolutionProposal(ws, "ep-missing")).toThrow(/proposal not found: ep-missing/);
  });

  it("accepts a pending proposal and stamps reviewedAt", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    const accepted = setEvolutionProposalStatus(ws, "ep-sess1-1", "accepted");
    expect(accepted.status).toBe("accepted");
    expect(accepted.reviewedAt).toBeDefined();
    // Persisted (file rewritten).
    expect(readEvolutionProposal(ws, "ep-sess1-1").status).toBe("accepted");
    expect(readProposalsRaw(ws)).toContain('"accepted"');
  });

  it("rejects a pending proposal", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    const rejected = setEvolutionProposalStatus(ws, "ep-sess1-1", "rejected");
    expect(rejected.status).toBe("rejected");
    expect(rejected.reviewedAt).toBeDefined();
  });

  it("only applies from accepted", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    expect(() => setEvolutionProposalStatus(ws, "ep-sess1-1", "applied")).toThrow(/must be accepted before apply/);
    setEvolutionProposalStatus(ws, "ep-sess1-1", "accepted");
    const applied = setEvolutionProposalStatus(ws, "ep-sess1-1", "applied");
    expect(applied.status).toBe("applied");
  });

  it("refuses accept/reject when the proposal is not pending", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    setEvolutionProposalStatus(ws, "ep-sess1-1", "accepted");
    expect(() => setEvolutionProposalStatus(ws, "ep-sess1-1", "accepted")).toThrow(/not pending/);
    expect(() => setEvolutionProposalStatus(ws, "ep-sess1-1", "rejected")).toThrow(/not pending/);
  });

  it("throws on unknown ids for status updates", () => {
    const ws = makeWorkspace();
    expect(() => setEvolutionProposalStatus(ws, "ep-missing", "accepted")).toThrow(/proposal not found/);
  });
});
