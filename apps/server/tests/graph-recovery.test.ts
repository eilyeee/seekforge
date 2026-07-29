import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireSessionLease,
  enqueueEngineeringGraphSignal,
  runEngineeringGraph,
  type AgentCoreDeps,
} from "@seekforge/core";
import { startServer, type RunGraphFn, type RunningServer } from "../src/index.js";
import { makeWorkspace, unusedAgentFactory, unusedLoopFactory, unusedResumeLoopFactory } from "./helpers.js";

describe("idle Graph recovery", () => {
  let server: RunningServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("keeps a normal recovery result when metadata cleanup fails", async () => {
    const workspace = makeWorkspace();
    const definition = {
      graphId: "idle-graph-cleanup",
      nodes: [{ id: "external", kind: "wait" as const, waitFor: { signal: "continue" } }],
    };
    const paused = await runEngineeringGraph({} as AgentCoreDeps, definition, { workspace });
    const recoverable = {
      ...paused,
      recovery: { attempts: 1, lastAttemptAt: "2020-01-01T00:00:00.000Z", lastError: "old" },
    };
    await enqueueEngineeringGraphSignal(workspace, definition.graphId, "continue");

    let blocker: ReturnType<typeof acquireSessionLease> | undefined;
    const runGraph = vi.fn<RunGraphFn>(async (_agentOpts, _definition, options) => {
      blocker = acquireSessionLease(workspace, `engineering-graph-${definition.graphId}`, options.workspaceGuard);
      return { ...recoverable, recoveryAttemptId: options.recoveryAttemptId };
    });
    const log = vi.fn();
    server = await startServer({
      workspace,
      port: 0,
      token: "test-token-graph-recovery",
      createAgent: unusedAgentFactory,
      runLoop: unusedLoopFactory,
      resumeLoop: unusedResumeLoopFactory,
      runGraph,
      graphAutoResume: true,
      graphMaintenanceInitialDelayMs: 5,
      graphMaintenanceIntervalMs: 60_000,
      logger: { log },
    });
    try {
      await vi.waitFor(() =>
        expect(log).toHaveBeenCalledWith(
          "error",
          "graph.recovery.cleanup_failed",
          expect.objectContaining({ workspace, graphId: definition.graphId }),
        ),
      );
      expect(runGraph).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalledWith(
        "error",
        "graph.recovery.failed",
        expect.objectContaining({ graphId: definition.graphId }),
      );
    } finally {
      blocker?.release();
    }
  });
});
