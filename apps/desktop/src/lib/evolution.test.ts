import { describe, expect, it } from "vitest";
import { transitionProposal } from "./evolution";
import type { EvolutionProposal } from "../types";

function proposal(id: string, status: EvolutionProposal["status"]): EvolutionProposal {
  return {
    id,
    sessionId: "s-1",
    type: "project_memory",
    title: "t",
    problem: "p",
    evidence: {},
    proposal: { content: "c" },
    risk: "low",
    status,
    createdAt: "2026-06-10T00:00:00.000Z",
  };
}

describe("transitionProposal", () => {
  it("accepts and rejects pending proposals", () => {
    const list = [proposal("a", "pending"), proposal("b", "pending")];
    expect(transitionProposal(list, "a", "accept")![0]!.status).toBe("accepted");
    expect(transitionProposal(list, "b", "reject")![1]!.status).toBe("rejected");
  });

  it("applies accepted proposals only", () => {
    const list = [proposal("a", "accepted"), proposal("b", "pending")];
    expect(transitionProposal(list, "a", "apply")![0]!.status).toBe("applied");
    expect(transitionProposal(list, "b", "apply")).toBeNull();
  });

  it("rejects invalid transitions and unknown ids", () => {
    const list = [proposal("a", "applied")];
    expect(transitionProposal(list, "a", "accept")).toBeNull();
    expect(transitionProposal(list, "a", "apply")).toBeNull();
    expect(transitionProposal(list, "nope", "accept")).toBeNull();
  });

  it("does not mutate the input list (rollback keeps the old reference valid)", () => {
    const list = [proposal("a", "pending")];
    const next = transitionProposal(list, "a", "accept")!;
    expect(list[0]!.status).toBe("pending");
    expect(next).not.toBe(list);
    expect(next[0]).not.toBe(list[0]);
  });
});
