import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkspaceOperationalDiagnostics } from "../../src/agent/orchestration-operations.js";
import { saveEngineeringGraphState } from "../../src/agent/graph-state.js";
import { createLoopState, saveLoopState } from "../../src/agent/loop-state.js";

describe("workspace operational diagnostics", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("combines bounded Loop, Graph, capacity, controller, and artifact diagnostics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-operations-"));
    workspaces.push(workspace);
    const loop = createLoopState({
      loopId: "operations-loop",
      task: "test diagnostics",
      workspace,
      verifyCommand: "pnpm test",
      maxIterations: 2,
    });
    saveLoopState(workspace, { ...loop, status: "passed", phase: "settled" });
    const now = new Date().toISOString();
    saveEngineeringGraphState(workspace, {
      schemaVersion: 2,
      graphId: "operations-graph",
      fingerprint: "a".repeat(64),
      status: "running",
      definition: { graphId: "operations-graph", nodes: [{ id: "done", kind: "function", handler: "noop" }] },
      results: [],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      elapsedMs: 0,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "run-a",
      priority: 0,
      createdAt: now,
      updatedAt: now,
    });

    expect(buildWorkspaceOperationalDiagnostics(workspace)).toMatchObject({
      healthy: expect.any(Boolean),
      controller: { mode: "active" },
      decisions: [],
      rollouts: [],
      loops: [expect.objectContaining({ kind: "loop", id: "operations-loop" })],
      graphs: [expect.objectContaining({ kind: "graph", id: "operations-graph" })],
      reservations: [],
      artifactStore: { blobs: 0, bytes: 0, referenced: 0, attestations: 0 },
    });
  });
});
