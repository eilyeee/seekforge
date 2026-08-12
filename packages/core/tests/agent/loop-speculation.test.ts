import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ChatResponse } from "@seekforge/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import {
  listLoopSpeculationStates,
  loadLoopSpeculationState,
  loopSpeculationGraphDefinition,
  promoteLoopSpeculation,
  runSpeculativeLoop,
} from "../../src/agent/loop-speculation.js";
import { createWorktree } from "../../src/worktree.js";

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

function candidateWorkspaces(root: string, ids: readonly string[]): Map<string, string> {
  const workspaces = new Map<string, string>();
  for (const id of ids) {
    const path = join(root, `candidate-${id}`.slice(0, 32));
    mkdirSync(path, { recursive: true });
    workspaces.set(id, path);
  }
  return workspaces;
}

function initRepository(root: string): void {
  writeFileSync(join(root, "base.txt"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "speculation-test@seekforge.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Speculation Test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: root });
}

describe("runSpeculativeLoop", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("sorts persisted offset timestamps by their epoch", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-state-"));
    roots.push(root);
    const directory = join(root, ".seekforge", "loop-speculations");
    mkdirSync(directory, { recursive: true });
    const state = (speculationId: string, updatedAt: string) => ({
      schemaVersion: 1,
      speculationId,
      fingerprint: "b".repeat(64),
      status: "running",
      createdAt: "2025-12-31T00:00:00.000Z",
      updatedAt,
      candidates: [],
    });
    writeFileSync(join(directory, "offset-old.json"), JSON.stringify(state("offset-old", "2026-01-01T00:30:00+01:00")));
    writeFileSync(join(directory, "utc-new.json"), JSON.stringify(state("utc-new", "2026-01-01T00:00:00Z")));

    expect(listLoopSpeculationStates(root).map((item) => item.speculationId)).toEqual(["utc-new", "offset-old"]);
  });

  it("fans out one shared budget rather than giving every candidate the whole cap", () => {
    const definition = loopSpeculationGraphDefinition(
      {
        workspace: "/tmp",
        task: "fix",
        verifyCommand: "test",
        costBudgetUsd: 0.5,
        candidates: [
          { id: "a", guidance: "a" },
          { id: "b", guidance: "b" },
        ],
        managedWorktrees: true,
      },
      { graphId: "spec-shape", loopOptions: { maxIterations: 2, maxNoProgressRecoveries: 0 } },
    );
    // One budget on the graph, no per-node budget, equal weights, and a slot
    // for every candidate: the engine can only split the cap between them.
    expect(definition.costBudgetUsd).toBe(0.5);
    expect(definition.maxConcurrency).toBe(2);
    expect(definition.nodes.every((node) => node.budgetWeight === undefined)).toBe(true);
    expect(definition.nodes.every((node) => node.loopOptions?.costBudgetUsd === undefined)).toBe(true);
    expect(definition.nodes.every((node) => (node.dependsOn ?? []).length === 0)).toBe(true);
    expect(definition.managedWorktrees).toEqual({ integrateDependencies: false, limit: 256 });
  });

  it("selects the lowest-cost passing isolated candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-"));
    roots.push(root);
    const workspaces = candidateWorkspaces(root, ["focused", "alternate"]);
    const result = await runSpeculativeLoop(deps, {
      workspace: root,
      task: "fix",
      verifyCommand: "test",
      costBudgetUsd: 1,
      candidates: [
        { id: "focused", guidance: "make a focused repair" },
        { id: "alternate", guidance: "try another repair" },
      ],
      workspaceForCandidate: (candidate) => workspaces.get(candidate.id)!,
      loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
    });
    expect(result.candidates.every((candidate) => candidate.status === "passed")).toBe(true);
    expect(result.winner?.id).toBe("focused");
  }, 30_000);

  it("gives every candidate a share of one shared cost budget, not the whole cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-budget-"));
    roots.push(root);
    const workspaces = candidateWorkspaces(root, ["first", "second", "third"]);
    const costBudgetUsd = 0.6;
    await runSpeculativeLoop(deps, {
      workspace: root,
      task: "fix",
      verifyCommand: "test",
      costBudgetUsd,
      tokenBudget: 30_000,
      candidates: [
        { id: "first", guidance: "one" },
        { id: "second", guidance: "two" },
        { id: "third", guidance: "three" },
      ],
      workspaceForCandidate: (candidate) => workspaces.get(candidate.id)!,
      loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
    });
    // The budget each candidate Loop was actually handed, read from its own
    // durable checkpoint: three candidates launched together must divide the
    // one cap, so seeing 0.6 anywhere would mean the cap was handed out whole.
    const budgets = [...workspaces.values()].map((workspace) => {
      const directory = join(workspace, ".seekforge", "loops");
      const states = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
      expect(states).toHaveLength(1);
      return (JSON.parse(readFileSync(join(directory, states[0]!), "utf8")) as { costBudgetUsd: number }).costBudgetUsd;
    });
    expect(budgets).toEqual([costBudgetUsd / 3, costBudgetUsd / 3, costBudgetUsd / 3]);
    expect(budgets.reduce((sum, budget) => sum + budget, 0)).toBeCloseTo(costBudgetUsd, 10);
  }, 60_000);

  it("requires isolation, a hard cost cap, and options the Graph can carry", async () => {
    const base = {
      workspace: "/tmp",
      task: "fix",
      verifyCommand: "test",
      candidates: [
        { id: "a", guidance: "a" },
        { id: "b", guidance: "b" },
      ],
    };
    await expect(runSpeculativeLoop(deps, { ...base, costBudgetUsd: 0 })).rejects.toThrow(/cost budget/);
    await expect(runSpeculativeLoop(deps, { ...base, costBudgetUsd: 1 })).rejects.toThrow(
      /managedWorktrees or workspaceForCandidate/,
    );
    await expect(
      runSpeculativeLoop(deps, {
        ...base,
        costBudgetUsd: 1,
        managedWorktrees: true,
        workspaceForCandidate: () => "/tmp",
      }),
    ).rejects.toThrow(/cannot be combined/);
    await expect(runSpeculativeLoop(deps, { ...base, costBudgetUsd: 1, managedWorktrees: true })).rejects.toThrow(
      /Loop speculation managedWorktrees require persistence/,
    );
    await expect(
      runSpeculativeLoop(deps, {
        ...base,
        costBudgetUsd: 1,
        workspaceForCandidate: () => "/tmp",
        loopOptions: { approvalMode: "confirm" } as never,
      }),
    ).rejects.toThrow(/unsupported option: approvalMode/);
    await expect(
      runSpeculativeLoop(deps, {
        ...base,
        costBudgetUsd: 1,
        workspaceForCandidate: () => "/tmp",
        verifierId: "fixture",
      }),
    ).rejects.toThrow(/verifierId requires loopOptions.verify/);
    await expect(
      runSpeculativeLoop(deps, {
        ...base,
        costBudgetUsd: 1,
        maxDurationMs: 25 * 60 * 60 * 1000,
        speculationId: "over-long",
        workspaceForCandidate: () => "/tmp",
        verifierId: "fixture",
        loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
      }),
    ).rejects.toThrow(/maxDurationMs must be 1 to/);
    await expect(
      runSpeculativeLoop(deps, {
        ...base,
        costBudgetUsd: 1,
        speculationId: "no-verifier-id",
        workspaceForCandidate: () => "/tmp",
        loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
      }),
    ).rejects.toThrow(/custom verifier requires verifierId/);
  });

  it("persists bounded candidate and winner state", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-persist-"));
    roots.push(root);
    const longCandidateId = `a${"x".repeat(63)}`;
    const workspaces = candidateWorkspaces(root, [longCandidateId, "b"]);
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
      workspaceForCandidate: (candidate: { id: string }) => workspaces.get(candidate.id)!,
      loopOptions: { verify: async () => ({ code: 0, output: "ok" }) },
    } satisfies Parameters<typeof runSpeculativeLoop>[1];
    const result = await runSpeculativeLoop(deps, options);
    expect(result.state).toMatchObject({
      schemaVersion: 1,
      speculationId: "persisted",
      status: "completed",
      winnerId: longCandidateId,
    });
    expect(loadLoopSpeculationState(root, "persisted")).toEqual(result.state);
    expect(listLoopSpeculationStates(root)).toHaveLength(1);
    await expect(runSpeculativeLoop(deps, options)).rejects.toThrow(/already exists/);

    const resumed = await runSpeculativeLoop(deps, { ...options, resume: true });
    expect(resumed.state?.createdAt).toBe(result.state?.createdAt);
    expect(resumed.state?.winnerId).toBe(longCandidateId);

    // A speculation checkpointed by the retired Loop DAG engine is named, not
    // reported as a missing Graph checkpoint.
    mkdirSync(join(root, ".seekforge", "loop-dags"), { recursive: true });
    writeFileSync(join(root, ".seekforge", "loop-dags", "spec-persisted.json"), "{}\n");
    await expect(runSpeculativeLoop(deps, { ...options, resume: true })).rejects.toThrow(
      /retired Loop DAG engine and cannot be resumed/,
    );
  }, 60_000);

  it("lists and promotes a speculation persisted by the retired engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-legacy-"));
    roots.push(root);
    initRepository(root);
    const winner = await createWorktree(root, "dag-legacy-winner");
    writeFileSync(join(winner.path, "winner.txt"), "winner\n");
    execFileSync("git", ["add", "-A"], { cwd: winner.path });
    execFileSync("git", ["commit", "-q", "-m", "candidate"], { cwd: winner.path });
    mkdirSync(join(root, ".seekforge", "loop-speculations"), { recursive: true });
    writeFileSync(
      join(root, ".seekforge", "loop-speculations", "legacy.json"),
      // Exactly what the Loop DAG engine wrote, including the `approved`
      // candidate status only that engine could produce.
      JSON.stringify({
        schemaVersion: 1,
        speculationId: "legacy",
        fingerprint: "c".repeat(64),
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T01:00:00.000Z",
        candidates: [
          { id: "alpha", status: "passed", costUsd: 0.5, iterations: 2, branch: winner.branch },
          { id: "beta", status: "approved", costUsd: 0.25, iterations: 1 },
        ],
        winnerId: "alpha",
      }),
    );

    expect(listLoopSpeculationStates(root).map((state) => state.speculationId)).toEqual(["legacy"]);
    const promoted = await promoteLoopSpeculation(root, "legacy");
    expect(promoted.status).toBe("promoted");
    expect(existsSync(join(root, "winner.txt"))).toBe(true);
    expect(loadLoopSpeculationState(root, "legacy")?.status).toBe("promoted");
  }, 30_000);

  it("runs candidates in retained managed worktrees and promotes the winner", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-speculate-managed-"));
    roots.push(root);
    initRepository(root);
    const result = await runSpeculativeLoop(deps, {
      workspace: root,
      task: "fix",
      verifyCommand: "custom",
      verifierId: "managed",
      costBudgetUsd: 1,
      speculationId: "managed",
      managedWorktrees: true,
      candidates: [
        { id: "cheap", guidance: "cheap repair" },
        { id: "costly", guidance: "costly repair" },
      ],
      loopOptions: {
        // Each candidate leaves a differently named file, so a worktree that
        // absorbed a sibling's work would be visible after promotion.
        verify: async (candidateWorkspace) => {
          writeFileSync(join(candidateWorkspace, `${basename(candidateWorkspace)}.txt`), "repaired\n");
          return { code: 0, output: "ok" };
        },
      },
    });
    const branches = result.candidates.map((candidate) => candidate.branch);
    expect(branches.every((branch) => branch?.startsWith("seekforge/"))).toBe(true);
    expect(new Set(branches).size).toBe(2);
    expect(result.winner?.branch).toBeDefined();
    const promoted = await promoteLoopSpeculation(root, "managed");
    expect(promoted.status).toBe("promoted");
    const marker = (branch: string | undefined) => `${branch!.slice("seekforge/".length)}.txt`;
    expect(existsSync(join(root, marker(result.winner?.branch)))).toBe(true);
    const losers = result.candidates.filter((candidate) => candidate.id !== result.winner?.id);
    expect(losers.every((candidate) => !existsSync(join(root, marker(candidate.branch))))).toBe(true);
  }, 60_000);
});
