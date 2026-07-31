import { describe, expect, it } from "vitest";
import { addMemoryFact, memoryGovernance, recordFactRetrieval } from "../../src/memory/index.js";
import { makeWorkspace } from "./helpers.js";

describe("memoryGovernance", () => {
  it("surfaces duplicates, conflicts, provenance, and retrieval quality without mutation", () => {
    const workspace = makeWorkspace();
    addMemoryFact(workspace, { content: "always use pnpm for package installs", type: "convention" });
    addMemoryFact(workspace, { content: "always use pnpm for package installation", type: "convention" });
    addMemoryFact(workspace, { content: "do not use pnpm for package installs", type: "convention" });
    recordFactRetrieval(workspace, "- [convention] always use pnpm for package installs");

    const report = memoryGovernance(workspace);
    expect(report.facts).toHaveLength(3);
    expect(report.facts[0]).toMatchObject({ sourceSessionId: "manual", retrievals: 1 });
    expect(report.duplicateGroups.length).toBeGreaterThan(0);
    expect(report.contradictionCandidates.length).toBeGreaterThan(0);
    expect(report.retrieval.retrievalToUseRate).toBe(1);
  });
});
