import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runEngineeringGraph, type GraphExecutionAdapter } from "../../src/agent/graph-engineering.js";
import {
  listWorkspaceGraphExecutorReservations,
  reconcileWorkspaceGraphExecutorCapacity,
} from "../../src/agent/graph-capacity.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

/**
 * Durable-engine suite: every state transition is an atomic write with two
 * fsyncs, which on a slow filesystem puts a single run at hundreds of
 * milliseconds and a multi-run test past Vitest's 5s default. See the note in
 * graph-engineering.test.ts for the measurement. Headroom, not a hang
 * workaround.
 */
vi.setConfig({ testTimeout: 30_000 });

describe("Graph workspace executor capacity integration", () => {
  it("coordinates concurrent Graph owners and releases capacity after settlement", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-capacity-integration-"));
    let releaseFirst = (): void => {};
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStartedResolve = (): void => {};
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    let executions = 0;
    const adapter: GraphExecutionAdapter = {
      trusted: true,
      locality: "remote",
      workspaceCapacity: 1,
      execute: async (context) => {
        executions++;
        if (context.idempotencyKey.startsWith("capacity-first:")) {
          firstStartedResolve();
          await firstBlocked;
        }
        return {};
      },
    };
    try {
      const first = runEngineeringGraph(
        {} as AgentCoreDeps,
        { graphId: "capacity-first", nodes: [{ id: "remote", kind: "remote", executor: "worker" }] },
        { workspace, executors: { worker: adapter } },
      );
      await firstStarted;
      const second = await runEngineeringGraph(
        {} as AgentCoreDeps,
        { graphId: "capacity-second", nodes: [{ id: "remote", kind: "remote", executor: "worker" }] },
        { workspace, executors: { worker: adapter } },
      );
      expect(second.status).toBe("failed");
      expect(executions).toBe(1);
      releaseFirst();
      expect((await first).status).toBe("passed");
      expect(listWorkspaceGraphExecutorReservations(workspace)).toEqual([]);
    } finally {
      releaseFirst();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("rejects a remote result after its exact workspace lease is lost", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-capacity-loss-"));
    let startedResolve = (): void => {};
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let executeResolve = (_value: { output: string }): void => {};
    const execution = new Promise<{ output: string }>((resolve) => {
      executeResolve = resolve;
    });
    let cancellations = 0;
    const adapter: GraphExecutionAdapter = {
      trusted: true,
      locality: "remote",
      workspaceCapacity: 1,
      execute: () => {
        startedResolve();
        return execution;
      },
      cancel: () => {
        cancellations++;
        executeResolve({ output: "late" });
      },
    };
    try {
      const run = runEngineeringGraph(
        {} as AgentCoreDeps,
        {
          graphId: "capacity-lost",
          nodes: [{ id: "remote", kind: "remote", executor: "worker", timeoutMs: 1_000 }],
        },
        { workspace, executors: { worker: adapter } },
      );
      await started;
      const reservation = listWorkspaceGraphExecutorReservations(workspace)[0]!;
      reconcileWorkspaceGraphExecutorCapacity(workspace, {
        orphanReservationIds: new Set([reservation.reservationId]),
      });
      const result = await run;
      expect(result.status).toBe("failed");
      expect(result.results[0]?.error).toMatch(/lost its workspace capacity lease/);
      expect(cancellations).toBe(1);
      expect(listWorkspaceGraphExecutorReservations(workspace)).toEqual([]);
    } finally {
      executeResolve({ output: "cleanup" });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
