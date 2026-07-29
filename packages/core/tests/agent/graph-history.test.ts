import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEngineeringGraphEvidenceReport,
  verifyEngineeringGraphEvidenceIntegrity,
} from "../../src/agent/graph-evidence.js";
import { createEngineeringGraphLogWriter, readEngineeringGraphHistory } from "../../src/agent/graph-history.js";
import { compareEngineeringGraphRuns } from "../../src/agent/graph-observability.js";
import {
  removeEngineeringGraphState,
  saveEngineeringGraphState,
  type EngineeringGraphState,
  type GraphEvent,
} from "../../src/agent/graph-state.js";

describe("Engineering Graph history and evidence", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  it("compares run and node usage without reading persistence", () => {
    const before = {
      graphId: "compare",
      status: "failed",
      spentCost: 1,
      spentTokens: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:10.000Z",
      results: [{ id: "work", status: "failed", costUsd: 1, tokensUsed: 100 }],
    } as EngineeringGraphState;
    const after = {
      graphId: "compare",
      status: "passed",
      spentCost: 1.5,
      spentTokens: 140,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:12.000Z",
      results: [{ id: "work", status: "passed", costUsd: 1.5, tokensUsed: 140 }],
    } as EngineeringGraphState;
    expect(compareEngineeringGraphRuns(before, after)).toMatchObject({
      statusChanged: true,
      costDeltaUsd: 0.5,
      tokenDelta: 40,
      durationDeltaMs: 2_000,
      nodes: [{ id: "work", before: "failed", after: "passed", costDeltaUsd: 0.5, tokenDelta: 40 }],
    });
  });

  it("appends JSONL history across writers with a monotonic log sequence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-history-"));
    workspaces.push(workspace);
    const event = (sequence: number): GraphEvent => ({
      sequence,
      type: "graph.started",
      timestamp: new Date().toISOString(),
      status: "running",
    });
    const first = createEngineeringGraphLogWriter(workspace, "history");
    first.append(event(1));
    first.close();
    const second = createEngineeringGraphLogWriter(workspace, "history");
    second.append(event(1));
    second.close();
    expect(readEngineeringGraphHistory(workspace, "history").map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("repairs a torn current suffix before continuing the log", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-history-"));
    workspaces.push(workspace);
    const event: GraphEvent = {
      sequence: 1,
      type: "graph.started",
      timestamp: new Date().toISOString(),
      status: "running",
    };
    const first = createEngineeringGraphLogWriter(workspace, "repair");
    first.append(event);
    first.close();
    appendFileSync(join(workspace, ".seekforge", "graphs", "repair.jsonl"), "{torn");
    const second = createEngineeringGraphLogWriter(workspace, "repair");
    second.append(event);
    second.close();
    expect(readEngineeringGraphHistory(workspace, "repair").map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("removes the checkpoint and bounded history as one leased resource", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-history-"));
    workspaces.push(workspace);
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 2,
      graphId: "remove",
      fingerprint: "b".repeat(64),
      status: "passed",
      definition: {
        graphId: "remove",
        nodes: [{ id: "done", kind: "function", handler: "noop" }],
        maxConcurrency: 1,
        failurePolicy: "stop",
      },
      results: [
        {
          id: "done",
          kind: "function",
          status: "passed",
          attempts: 1,
          costUsd: 0,
          tokensUsed: 0,
          startedAt: now,
          completedAt: now,
        },
      ],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    } as EngineeringGraphState;
    saveEngineeringGraphState(workspace, state);
    const writer = createEngineeringGraphLogWriter(workspace, "remove");
    writer.append({ sequence: 1, type: "graph.completed", timestamp: now, status: "passed" });
    writer.close();
    expect(removeEngineeringGraphState(workspace, "remove")).toBe(true);
    expect(existsSync(join(workspace, ".seekforge", "graphs", "remove.json"))).toBe(false);
    expect(existsSync(join(workspace, ".seekforge", "graphs", "remove.jsonl"))).toBe(false);
  });

  it("builds tamper-evident evidence without node outputs", () => {
    const now = new Date().toISOString();
    const state = {
      schemaVersion: 2,
      graphId: "evidence",
      fingerprint: "a".repeat(64),
      status: "passed",
      definition: { graphId: "evidence", nodes: [], maxConcurrency: 1, failurePolicy: "stop" },
      results: [
        {
          id: "done",
          kind: "function",
          status: "passed",
          attempts: 1,
          costUsd: 0,
          tokensUsed: 0,
          startedAt: now,
          completedAt: now,
          output: { secret: true },
        },
      ],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    } as EngineeringGraphState;
    const report = buildEngineeringGraphEvidenceReport(state);
    expect(report.nodes[0]).not.toHaveProperty("output");
    expect(verifyEngineeringGraphEvidenceIntegrity(report)).toBe(true);
    expect(verifyEngineeringGraphEvidenceIntegrity({ ...report, status: "failed" })).toBe(false);
  });
});
