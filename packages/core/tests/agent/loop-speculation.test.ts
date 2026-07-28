import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import {
  listLoopSpeculationStates,
  loadLoopSpeculationState,
  runSpeculativeLoop,
} from "../../src/agent/loop-speculation.js";

const usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0.001 };
const deps: AgentCoreDeps = {
  provider: {
    model: "test",
    async chat(): Promise<ChatResponse> {
      return { content: "done", toolCalls: [], usage, finishReason: "stop" };
    },
    async chatStream(): Promise<ChatResponse> {
      return this.chat({ messages: [] });
    },
  },
  dispatcher: { list: () => [], execute: async () => ({ ok: true }) },
  confirm: async () => true,
};

describe("runSpeculativeLoop", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("selects the lowest-cost passing isolated candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-"));
    const a = mkdtempSync(join(tmpdir(), "seekforge-speculate-a-"));
    const b = mkdtempSync(join(tmpdir(), "seekforge-speculate-b-"));
    roots.push(root, a, b);
    const result = await runSpeculativeLoop(deps, {
      workspace: root,
      task: "fix",
      verifyCommand: "test",
      costBudgetUsd: 1,
      candidates: [
        { id: "focused", guidance: "make a focused repair" },
        { id: "alternate", guidance: "try another repair" },
      ],
      workspaceForCandidate: (candidate) => (candidate.id === "focused" ? a : b),
      loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
    });
    expect(result.candidates.every((candidate) => candidate.status === "passed")).toBe(true);
    expect(result.winner?.id).toBe("focused");
  });

  it("requires isolation and a hard cost cap", async () => {
    await expect(
      runSpeculativeLoop(deps, {
        workspace: "/tmp",
        task: "fix",
        verifyCommand: "test",
        costBudgetUsd: 0,
        candidates: [
          { id: "a", guidance: "a" },
          { id: "b", guidance: "b" },
        ],
      }),
    ).rejects.toThrow(/cost budget/);
  });

  it("persists bounded candidate and winner state", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-"));
    const a = mkdtempSync(join(tmpdir(), "seekforge-speculate-a-"));
    const b = mkdtempSync(join(tmpdir(), "seekforge-speculate-b-"));
    roots.push(root, a, b);
    const longCandidateId = `a${"x".repeat(63)}`;
    const options = {
      workspace: root,
      task: "fix",
      verifyCommand: "test",
      verifierId: "fixture",
      costBudgetUsd: 1,
      speculationId: "persisted",
      candidates: [
        { id: longCandidateId, guidance: "first" },
        { id: "b", guidance: "second" },
      ],
      workspaceForCandidate: (candidate) => (candidate.id === longCandidateId ? a : b),
      loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
    } satisfies Parameters<typeof runSpeculativeLoop>[1];
    const result = await runSpeculativeLoop(deps, options);
    expect(result.state).toMatchObject({
      speculationId: "persisted",
      status: "completed",
      winnerId: longCandidateId,
    });
    expect(loadLoopSpeculationState(root, "persisted")).toEqual(result.state);
    expect(listLoopSpeculationStates(root)).toHaveLength(1);
    await expect(runSpeculativeLoop(deps, options)).rejects.toThrow(/already exists/);
  });
});
