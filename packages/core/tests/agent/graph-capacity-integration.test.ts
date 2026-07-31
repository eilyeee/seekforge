import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEngineeringGraph, type GraphExecutionAdapter } from "../../src/agent/graph-engineering.js";
import { listWorkspaceGraphExecutorReservations } from "../../src/agent/graph-capacity.js";
import type { AgentCoreDeps } from "../../src/agent/loop.js";

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
});
