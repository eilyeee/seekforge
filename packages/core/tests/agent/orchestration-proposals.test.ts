import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listOrchestrationProposals,
  recordOrchestrationProposals,
  setOrchestrationProposalStatus,
} from "../../src/agent/orchestration-proposals.js";
import type { OrchestrationProposalDraft } from "../../src/agent/orchestration-intelligence.js";

const draft = (id = `opt-${"a".repeat(20)}`): OrchestrationProposalDraft => ({
  id,
  scope: "graph",
  sourceId: "graph",
  sourceFingerprint: "b".repeat(64),
  confidence: "medium",
  evidenceCount: 4,
  risk: "low",
  title: "Raise capacity",
  rationale: "Measured resource contention",
  action: { kind: "graph_resource_capacity", resource: "cpu", value: 2 },
});

describe("orchestration proposal lifecycle", () => {
  const workspaces: string[] = [];
  const workspace = () => {
    const result = mkdtempSync(join(tmpdir(), "seekforge-orchestration-proposals-"));
    workspaces.push(result);
    return result;
  };
  afterEach(() => {
    for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("preserves explicit decisions across refresh and rejects stale review versions", () => {
    const root = workspace();
    const proposed = recordOrchestrationProposals(root, [draft()])[0]!;
    const approved = setOrchestrationProposalStatus(root, proposed.id, "approved", proposed.updatedAt);
    expect(approved.status).toBe("approved");
    expect(approved.updatedAt).not.toBe(proposed.updatedAt);
    expect(() => setOrchestrationProposalStatus(root, proposed.id, "dismissed", proposed.updatedAt)).toThrow(
      /changed since/,
    );
    expect(recordOrchestrationProposals(root, [draft()])[0]!.status).toBe("approved");
    const refreshed = recordOrchestrationProposals(root, [{ ...draft(), evidenceCount: 5 }])[0]!;
    expect(refreshed.updatedAt).not.toBe(approved.updatedAt);
    expect(() => setOrchestrationProposalStatus(root, proposed.id, "dismissed", approved.updatedAt)).toThrow(
      /changed since/,
    );
  });

  it("fails closed on malformed durable content and invalid generated actions", () => {
    const root = workspace();
    const target = join(root, ".seekforge", "orchestration-proposals.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ version: 1, proposals: [{ forged: true }] }));
    expect(listOrchestrationProposals(root)).toEqual([]);
    expect(() => recordOrchestrationProposals(root, [draft()])).toThrow(
      /persisted orchestration proposals are invalid/i,
    );

    const clean = workspace();
    expect(() =>
      recordOrchestrationProposals(clean, [{ ...draft(), action: { kind: "graph_concurrency", value: 99 } }]),
    ).toThrow(/invalid/);

    const duplicate = workspace();
    const proposal = recordOrchestrationProposals(duplicate, [draft()])[0]!;
    const duplicateTarget = join(duplicate, ".seekforge", "orchestration-proposals.json");
    writeFileSync(duplicateTarget, JSON.stringify({ version: 1, proposals: [proposal, proposal] }));
    expect(() => recordOrchestrationProposals(duplicate, [draft()])).toThrow(/invalid/);
  });

  it("retains reviewed decisions ahead of newer unreviewed proposals", () => {
    const root = workspace();
    const reviewed = recordOrchestrationProposals(root, [draft()])[0]!;
    setOrchestrationProposalStatus(root, reviewed.id, "approved", reviewed.updatedAt);
    const many = Array.from({ length: 140 }, (_, index) => draft(`opt-${(index + 1).toString(16).padStart(20, "0")}`));
    recordOrchestrationProposals(root, many);
    expect(listOrchestrationProposals(root)).toContainEqual(
      expect.objectContaining({ id: reviewed.id, status: "approved" }),
    );
  });

  it("ranks and bounds large generated batches deterministically", () => {
    const root = workspace();
    const drafts = Array.from({ length: 140 }, (_, index) => ({
      ...draft(`opt-${index.toString(16).padStart(20, "0")}`),
      confidence: (index < 10 ? "high" : "low") as "high" | "low",
      evidenceCount: index,
    }));
    const recorded = recordOrchestrationProposals(root, drafts);
    expect(recorded).toHaveLength(128);
    expect(recorded.slice(0, 10).every((proposal) => proposal.confidence === "high")).toBe(true);
    expect(listOrchestrationProposals(root)).toHaveLength(128);
    expect(() =>
      recordOrchestrationProposals(root, [
        ...drafts,
        { ...draft(`opt-${"f".repeat(20)}`), action: { kind: "graph_concurrency", value: 99 } },
      ]),
    ).toThrow(/invalid/);
  });
});
