import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeOrchestrationDecision,
  fingerprintOrchestrationDecisionInput,
  listOrchestrationDecisions,
  readOrchestrationControllerState,
  reconcileOrchestrationController,
  recordOrchestrationDecision,
  resumeOrchestrationController,
} from "../../src/agent/orchestration-decisions.js";
import { recordOrchestrationDeploymentObservation } from "../../src/agent/orchestration-control.js";
import type { OrchestrationDeployment } from "../../src/agent/orchestration-deployments.js";
import { runEngineeringGraph } from "../../src/agent/graph-engineering.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

function freezeController(root: string): void {
  const recordedAt = "2026-07-31T00:00:00.000Z";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const deployment: OrchestrationDeployment = {
      proposalId: `opt-${String(attempt).repeat(20)}`,
      proposalUpdatedAt: recordedAt,
      scope: "loop",
      sourceId: "loop-1",
      sourceFingerprint: "a".repeat(64),
      action: { kind: "loop_route", failureCategory: "test", model: "model-a" },
      status: "applied",
      attempt,
      startedAt: recordedAt,
      updatedAt: recordedAt,
      appliedAt: recordedAt,
      baseline: { costPerUnit: 1, durationPerUnitMs: 100, failures: 0, terminal: true },
      observed: { costPerUnit: 2, durationPerUnitMs: 200, failures: 1, terminal: true },
      verdict: "regressed",
    };
    recordOrchestrationDeploymentObservation(root, deployment);
  }
  reconcileOrchestrationController(root, { now: new Date("2026-07-31T00:01:00.000Z") });
}

describe("orchestration decisions", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records versioned decisions and binds one terminal outcome", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-decision-"));
    roots.push(root);
    const inputFingerprint = fingerprintOrchestrationDecisionInput({ ready: ["build"] });
    const decision = recordOrchestrationDecision(root, {
      kind: "graph_schedule",
      scope: "graph",
      sourceId: "graph-1",
      policyVersion: 1,
      inputFingerprint,
      status: "adopted",
      reasons: ["critical path first"],
      selected: ["build"],
    });
    expect(completeOrchestrationDecision(root, decision.id, "passed").outcome).toBe("passed");
    expect(completeOrchestrationDecision(root, decision.id, "failed").outcome).toBe("passed");
    expect(listOrchestrationDecisions(root)).toHaveLength(1);
  });

  it("preserves only unfinished preflights when they fill the retention window", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-decision-retention-"));
    roots.push(root);
    const decidedAt = "2026-07-31T00:00:00.000Z";
    const decisions = Array.from({ length: 511 }, (_, index) => ({
      id: index.toString(16).padStart(64, "0"),
      kind: "graph_preflight",
      scope: "graph",
      sourceId: `graph-${index}`,
      policyVersion: 1,
      inputFingerprint: index.toString(16).padStart(64, "0"),
      status: "advisory",
      reasons: ["active preflight"],
      selected: ["build"],
      decidedAt,
    }));
    mkdirSync(join(root, ".seekforge"));
    writeFileSync(
      join(root, ".seekforge", "orchestration-decisions.json"),
      `${JSON.stringify({
        version: 1,
        decisions: [
          {
            id: "f".repeat(64),
            kind: "graph_schedule",
            scope: "graph",
            sourceId: "old-schedule",
            policyVersion: 1,
            inputFingerprint: "a".repeat(64),
            status: "adopted",
            reasons: ["old terminal decision"],
            selected: ["build"],
            decidedAt,
          },
          ...decisions,
        ],
      })}\n`,
    );
    recordOrchestrationDecision(root, {
      kind: "graph_preflight",
      scope: "graph",
      sourceId: "graph-final",
      policyVersion: 1,
      inputFingerprint: "e".repeat(64),
      status: "advisory",
      reasons: ["active preflight"],
      selected: ["build"],
    });
    const retained = listOrchestrationDecisions(root);
    expect(retained).toHaveLength(512);
    expect(retained.every((decision) => decision.kind === "graph_preflight")).toBe(true);
  });

  it("defaults active and supports an explicit resume marker", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-controller-"));
    roots.push(root);
    expect(readOrchestrationControllerState(root).mode).toBe("active");
    expect(resumeOrchestrationController(root, "operator approved")).toMatchObject({
      mode: "active",
      reason: "operator approved",
    });
  });

  it("binds Graph preflight and safe-boundary scheduling to a terminal outcome", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-decision-graph-"));
    roots.push(root);
    const result = await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "decision-graph",
        adaptiveScheduling: true,
        nodes: [{ id: "build", kind: "function", handler: "build" }],
      },
      { workspace: root, handlers: { build: () => ({ output: "ok" }) } },
    );
    expect(result.status).toBe("passed");
    expect(listOrchestrationDecisions(root)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "graph_preflight", sourceId: "decision-graph", outcome: "passed" }),
        expect.objectContaining({ kind: "graph_schedule", sourceId: "decision-graph", status: "adopted" }),
      ]),
    );
  });

  it("re-enables learned Graph scheduling at a later safe boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-decision-controller-transition-"));
    roots.push(root);
    freezeController(root);
    const result = await runEngineeringGraph(
      {} as AgentCoreDeps,
      {
        graphId: "controller-transition",
        adaptiveScheduling: true,
        maxConcurrency: 1,
        nodes: [
          { id: "a-resume", kind: "function", handler: "resume" },
          { id: "b-finish", kind: "function", handler: "finish" },
        ],
      },
      {
        workspace: root,
        handlers: {
          resume: () => {
            resumeOrchestrationController(root, "recovered during run");
            return {};
          },
          finish: () => ({}),
        },
      },
    );
    expect(result.status).toBe("passed");
    const statuses = listOrchestrationDecisions(root)
      .filter((decision) => decision.kind === "graph_schedule")
      .map((decision) => decision.status);
    expect(statuses).toEqual(expect.arrayContaining(["frozen", "adopted"]));
  });

  it("freezes learned decisions after sustained critical burn", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-controller-burn-"));
    roots.push(root);
    freezeController(root);
    expect(readOrchestrationControllerState(root)).toMatchObject({
      mode: "frozen",
      criticalSince: expect.any(String),
    });
  });
});
