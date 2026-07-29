import { describe, expect, it } from "vitest";
import {
  diagnoseEngineeringGraphCheckpoint,
  diagnoseLoopCheckpoint,
  replayOrchestrationTransitions,
} from "../../src/agent/orchestration-diagnostics.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";
import type { LoopState } from "../../src/agent/loop-state.js";

const loopState = (): LoopState => ({
  schemaVersion: 2,
  loopId: "loop-a",
  task: "task",
  workspace: "/tmp/workspace",
  verifyCommand: "pnpm test",
  maxIterations: 3,
  costBudgetUsd: null,
  iterations: 1,
  costUsd: 0,
  sessionId: "session",
  lastVerify: { code: 0, output: "ok" },
  requirementMode: "quick",
  status: "passed",
  phase: "settled",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
});

const graphState = (): EngineeringGraphState => ({
  schemaVersion: 2,
  graphId: "graph-a",
  fingerprint: "a".repeat(64),
  status: "running",
  definition: { graphId: "graph-a", nodes: [{ id: "one", kind: "function", handler: "noop" }] },
  results: [],
  events: [],
  spentCost: 0,
  spentTokens: 0,
  elapsedMs: 0,
  activeAttempts: [],
  controlSeq: 0,
  controlRunId: "run-a",
  priority: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
});

describe("orchestration diagnostics", () => {
  it("replays a strictly ordered event window", () => {
    expect(
      replayOrchestrationTransitions(
        0,
        [
          { seq: 1, event: 2 },
          { seq: 2, event: 3 },
        ],
        (sum, event) => sum + event,
      ),
    ).toBe(5);
    expect(() =>
      replayOrchestrationTransitions(
        0,
        [
          { seq: 2, event: 1 },
          { seq: 2, event: 1 },
        ],
        (sum, event) => sum + event,
      ),
    ).toThrow(/strictly increasing/);
  });

  it("detects a Loop terminal mismatch without treating absent history as corrupt", () => {
    const absent = diagnoseLoopCheckpoint(loopState(), []);
    expect(absent.healthy).toBe(true);
    expect(absent.issues).toContainEqual(expect.objectContaining({ code: "history_unavailable", severity: "warning" }));
    const report = diagnoseLoopCheckpoint(loopState(), [
      {
        seq: 1,
        ts: "2026-01-01T00:00:01.000Z",
        event: {
          type: "loop.done",
          result: {
            status: "cancelled",
            iterations: 1,
            costUsd: 0,
            sessionId: "session",
            finalVerify: { code: -1, output: "cancelled" },
          },
        },
      },
    ]);
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "terminal_status_mismatch" }));
  });

  it("reports a malformed loosely retained Loop event instead of throwing", () => {
    const report = diagnoseLoopCheckpoint(loopState(), [
      {
        seq: 1,
        ts: "2026-01-01T00:00:01.000Z",
        event: { type: "loop.done" },
      } as never,
    ]);
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "event_payload_invalid" }));
  });

  it("detects a Graph active effect that also has a settled result", () => {
    const state = graphState();
    state.results = [
      {
        id: "one",
        kind: "function",
        status: "passed",
        attempts: 1,
        costUsd: 0,
        tokensUsed: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    state.activeAttempts = [
      {
        nodeId: "one",
        attempt: 1,
        idempotencyKey: "key",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const report = diagnoseEngineeringGraphCheckpoint(state, []);
    expect(report.healthy).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: "active_attempt_has_result", nodeId: "one" }));
  });

  it("falls back to the checkpoint's retained Graph events", () => {
    const state = graphState();
    state.events = [
      {
        sequence: 1,
        type: "node.started",
        timestamp: "2026-01-01T00:00:00.000Z",
        nodeId: "one",
      },
    ];
    const report = diagnoseEngineeringGraphCheckpoint(state, []);
    expect(report.observedEvents).toBe(1);
    expect(report.issues).not.toContainEqual(expect.objectContaining({ code: "history_unavailable" }));
  });
});
