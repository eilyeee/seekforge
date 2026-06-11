import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendEvolutionProposals,
  applyProposal,
  readEvolutionProposal,
  setEvolutionProposalStatus,
} from "../../src/evolution/index.js";
import { makeProposal, makeWorkspace } from "./helpers.js";

function seedAccepted(ws: string, overrides: Parameters<typeof makeProposal>[0] = {}) {
  const proposal = makeProposal(overrides);
  appendEvolutionProposals(ws, [proposal]);
  setEvolutionProposalStatus(ws, proposal.id, "accepted");
  return proposal;
}

function readAgentsMd(ws: string): string {
  return fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8");
}

describe("applyProposal gates", () => {
  it("refuses pending proposals", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    expect(() => applyProposal(ws, "ep-sess1-1")).toThrow(/must be accepted before apply/);
    expect(fs.existsSync(path.join(ws, "AGENTS.md"))).toBe(false);
  });

  it("refuses rejected and already-applied proposals", () => {
    const ws = makeWorkspace();
    appendEvolutionProposals(ws, [makeProposal()]);
    setEvolutionProposalStatus(ws, "ep-sess1-1", "rejected");
    expect(() => applyProposal(ws, "ep-sess1-1")).toThrow(/status: rejected/);

    const second = seedAccepted(ws, { id: "ep-sess1-2", title: "Another rule" });
    applyProposal(ws, second.id);
    expect(() => applyProposal(ws, second.id)).toThrow(/status: applied/);
  });

  it("throws on unknown ids", () => {
    const ws = makeWorkspace();
    expect(() => applyProposal(ws, "ep-missing")).toThrow(/proposal not found/);
  });
});

describe("applyProposal agent_rule", () => {
  it("creates AGENTS.md with an Agent Rules section when missing", () => {
    const ws = makeWorkspace();
    const p = seedAccepted(ws);
    const { proposal, changedPath } = applyProposal(ws, p.id);

    expect(changedPath).toBe(path.join(ws, "AGENTS.md"));
    expect(readAgentsMd(ws)).toBe(
      "# AGENTS.md\n\n## Agent Rules\n\n- Run pnpm typecheck after editing TypeScript files.\n",
    );
    expect(proposal.status).toBe("applied");
    expect(readEvolutionProposal(ws, p.id).status).toBe("applied");
  });

  it("appends inside an existing Agent Rules section, before later sections", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(
      path.join(ws, "AGENTS.md"),
      "# AGENTS.md\n\n## Agent Rules\n\n- Existing rule.\n\n## Coding Style\n\n- Keep it small.\n",
    );
    const p = seedAccepted(ws);
    applyProposal(ws, p.id);

    expect(readAgentsMd(ws)).toBe(
      "# AGENTS.md\n\n## Agent Rules\n\n- Existing rule.\n- Run pnpm typecheck after editing TypeScript files.\n\n## Coding Style\n\n- Keep it small.\n",
    );
  });

  it("adds the section at the end when AGENTS.md lacks it", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n\n## Coding Style\n\n- Be tidy.\n");
    const p = seedAccepted(ws);
    applyProposal(ws, p.id);

    expect(readAgentsMd(ws)).toBe(
      "# AGENTS.md\n\n## Coding Style\n\n- Be tidy.\n\n## Agent Rules\n\n- Run pnpm typecheck after editing TypeScript files.\n",
    );
  });

  it("does not duplicate an identical rule line but still marks applied", () => {
    const ws = makeWorkspace();
    fs.writeFileSync(
      path.join(ws, "AGENTS.md"),
      "# AGENTS.md\n\n## Agent Rules\n\n- Run pnpm typecheck after editing TypeScript files.\n",
    );
    const before = readAgentsMd(ws);
    const p = seedAccepted(ws);
    const { proposal } = applyProposal(ws, p.id);

    expect(readAgentsMd(ws)).toBe(before);
    expect(proposal.status).toBe("applied");
  });
});

describe("applyProposal project_memory", () => {
  const memoryProposal = {
    id: "ep-sess1-7",
    type: "project_memory" as const,
    title: "Tests run with pnpm",
    proposal: { content: "Tests are run with `pnpm test`." },
  };

  it("creates project.md with a header and the convention bullet", () => {
    const ws = makeWorkspace();
    const p = seedAccepted(ws, memoryProposal);
    const { changedPath } = applyProposal(ws, p.id);

    const file = path.join(ws, ".seekforge", "memory", "project.md");
    expect(changedPath).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "# Project Memory\n- [convention] Tests are run with `pnpm test`.\n",
    );
  });

  it("appends to an existing project.md and dedupes identical bullets", () => {
    const ws = makeWorkspace();
    const file = path.join(ws, ".seekforge", "memory", "project.md");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# Project Memory\n- [command] use pnpm\n");

    const p = seedAccepted(ws, memoryProposal);
    applyProposal(ws, p.id);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "# Project Memory\n- [command] use pnpm\n- [convention] Tests are run with `pnpm test`.\n",
    );

    const dup = seedAccepted(ws, { ...memoryProposal, id: "ep-sess1-8", title: "Dup" });
    applyProposal(ws, dup.id);
    expect(fs.readFileSync(file, "utf8")).toBe(
      "# Project Memory\n- [command] use pnpm\n- [convention] Tests are run with `pnpm test`.\n",
    );
  });
});

describe("applyProposal skill", () => {
  const SKILL_BODY =
    "# fix-flaky-tests\n\n## When to Use\n- flaky tests\n\n## Procedure\n1. rerun\n\n## Verification\n- pnpm test passes twice\n";

  const skillProposal = {
    id: "ep-sess1-9",
    type: "skill" as const,
    title: "Fix flaky tests",
    proposal: { content: SKILL_BODY, skillId: "fix-flaky-tests" },
  };

  it("scaffolds the skill and overwrites SKILL.md with the proposed body", () => {
    const ws = makeWorkspace();
    const p = seedAccepted(ws, skillProposal);
    const { changedPath } = applyProposal(ws, p.id);

    const dir = path.join(ws, ".seekforge", "skills", "fix-flaky-tests");
    expect(changedPath).toBe(path.join(dir, "SKILL.md"));
    expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe(SKILL_BODY);
    // Scaffolded metadata still present.
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "skill.json"), "utf8")) as { id: string };
    expect(meta.id).toBe("fix-flaky-tests");
    expect(readEvolutionProposal(ws, p.id).status).toBe("applied");
  });

  it("fails with skill_exists when the skill directory is already there", () => {
    const ws = makeWorkspace();
    fs.mkdirSync(path.join(ws, ".seekforge", "skills", "fix-flaky-tests"), { recursive: true });
    const p = seedAccepted(ws, skillProposal);
    expect(() => applyProposal(ws, p.id)).toThrow(/skill_exists/);
    // Apply failed → proposal stays accepted, not applied.
    expect(readEvolutionProposal(ws, p.id).status).toBe("accepted");
  });

  it("fails when a skill proposal lacks a skillId", () => {
    const ws = makeWorkspace();
    const p = seedAccepted(ws, {
      id: "ep-sess1-10",
      type: "skill",
      title: "No id",
      proposal: { content: SKILL_BODY },
    });
    expect(() => applyProposal(ws, p.id)).toThrow(/no skillId/);
  });
});
