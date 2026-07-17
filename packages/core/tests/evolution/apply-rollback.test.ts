import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendEvolutionProposals,
  applyProposal,
  readEvolutionProposal,
  setEvolutionProposalStatus,
} from "../../src/evolution/index.js";
import { makeProposal, makeWorkspace } from "./helpers.js";

// Shared call counter so the mocked scaffold fails exactly once (leaving a
// half-built directory), then delegates to the real implementation on retry.
const state = vi.hoisted(() => ({ calls: 0 }));

// Mock ONLY createSkillScaffold: on the first call it partially creates the
// skill directory (dir + skill.json) and throws, simulating a crash/IO error
// mid-scaffold. Every other export stays real.
vi.mock("../../src/skills/index.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/skills/index.js")>();
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  return {
    ...actual,
    createSkillScaffold: (workspace: string, id: string): string => {
      state.calls += 1;
      if (state.calls === 1) {
        const dir = nodePath.join(workspace, ".seekforge", "skills", id);
        nodeFs.mkdirSync(dir, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(dir, "skill.json"), "{}\n");
        throw new Error("scaffold boom");
      }
      return actual.createSkillScaffold(workspace, id);
    },
  };
});

const SKILL_BODY = "# fix-flaky-tests\n\n## Procedure\n1. rerun\n";

const skillProposal = {
  id: "ep-sess1-9",
  type: "skill" as const,
  title: "Fix flaky tests",
  proposal: { content: SKILL_BODY, skillId: "fix-flaky-tests" },
};

function seedAccepted(ws: string): void {
  const proposal = makeProposal(skillProposal);
  appendEvolutionProposals(ws, [proposal]);
  setEvolutionProposalStatus(ws, proposal.id, "accepted");
}

describe("applySkill rollback", () => {
  it("removes the half-built skill dir on failure and stays retryable (no skill_exists deadlock)", () => {
    const ws = makeWorkspace();
    seedAccepted(ws);
    const dir = path.join(ws, ".seekforge", "skills", "fix-flaky-tests");

    // First apply fails mid-scaffold; the partial dir must be rolled back.
    expect(() => applyProposal(ws, skillProposal.id)).toThrow(/scaffold boom/);
    expect(fs.existsSync(dir)).toBe(false);
    // Proposal is untouched (still accepted), so it can be retried.
    expect(readEvolutionProposal(ws, skillProposal.id).status).toBe("accepted");

    // Retry now succeeds — before the fix, the leftover dir would make this throw
    // "skill_exists" forever.
    const { changedPath } = applyProposal(ws, skillProposal.id);
    expect(changedPath).toBe(path.join(dir, "SKILL.md"));
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(SKILL_BODY);
    expect(readEvolutionProposal(ws, skillProposal.id).status).toBe("applied");
  });
});
