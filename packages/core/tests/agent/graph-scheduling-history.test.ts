import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeGraphSchedulingIntelligence,
  graphSchedulingScore,
  readGraphSchedulingObservations,
  predictGraphNodeScheduling,
  recordGraphSchedulingObservation,
  summarizeGraphSchedulingIntelligence,
  type GraphSchedulingObservation,
} from "../../src/agent/graph-scheduling-history.js";

describe("Graph scheduling intelligence", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  const workspace = (): string => {
    const path = mkdtempSync(join(tmpdir(), "seekforge-graph-scheduling-"));
    workspaces.push(path);
    return path;
  };
  const fingerprint = "a".repeat(64);
  const observation = (overrides: Partial<GraphSchedulingObservation> = {}): GraphSchedulingObservation => ({
    graphId: "delivery",
    nodeId: "tests",
    fingerprint,
    durationMs: 100,
    passed: true,
    recordedAt: new Date().toISOString(),
    ...overrides,
  });

  it("isolates scores by exact Graph definition fingerprint", () => {
    const root = workspace();
    recordGraphSchedulingObservation(root, observation({ passed: false }));
    expect(graphSchedulingScore(root, "delivery", fingerprint, "tests")).toBeGreaterThan(1_000_000);
    expect(graphSchedulingScore(root, "delivery", "b".repeat(64), "tests")).toBe(0);
    expect(graphSchedulingScore(root, "delivery", "tests")).toBe(0);
  });

  it("uses parsed event time instead of delayed append order", () => {
    const newer = observation({ passed: true, recordedAt: new Date(Date.now() - 1_000).toISOString() });
    const older = observation({ passed: false, recordedAt: new Date(Date.now() - 2_000).toISOString() });
    expect(summarizeGraphSchedulingIntelligence([newer, older])).toEqual([
      expect.objectContaining({
        samples: 2,
        consecutiveFailures: 0,
        lastPassed: true,
        updatedAt: newer.recordedAt,
      }),
    ]);
    const root = workspace();
    recordGraphSchedulingObservation(root, newer);
    recordGraphSchedulingObservation(root, older);
    expect(readGraphSchedulingObservations(root).map((item) => item.recordedAt)).toEqual([
      older.recordedAt,
      newer.recordedAt,
    ]);
  });

  it("summarizes bounded outcomes and reports sustained anomalies", () => {
    const observations = Array.from({ length: 4 }, (_, index) =>
      observation({ durationMs: 100 + index * 100, passed: index === 0 }),
    );
    const entries = summarizeGraphSchedulingIntelligence(observations);
    expect(entries).toEqual([
      expect.objectContaining({
        samples: 4,
        passes: 1,
        failures: 3,
        consecutiveFailures: 3,
        averageDurationMs: 250,
        p50DurationMs: 200,
        p95DurationMs: 400,
        confidence: "medium",
        lastPassed: false,
      }),
    ]);
    expect(analyzeGraphSchedulingIntelligence(entries).map((finding) => finding.kind)).toEqual([
      "failure_streak",
      "failure_rate",
    ]);
  });

  it("calibrates forecasts and resource waits without changing eligibility", () => {
    const observations = [
      observation({ durationMs: 100, predictedDurationMs: 80, resourceWaitMs: 20 }),
      observation({ durationMs: 300, predictedDurationMs: 200, resourceWaitMs: 40, passed: false }),
    ];
    expect(predictGraphNodeScheduling(observations, "delivery", fingerprint, "tests")).toMatchObject({
      p50DurationMs: 100,
      p95DurationMs: 300,
      confidence: "low",
    });
    expect(summarizeGraphSchedulingIntelligence(observations)[0]).toMatchObject({
      averagePredictionErrorMs: 60,
      averageResourceWaitMs: 30,
    });
    expect(summarizeGraphSchedulingIntelligence([observation()])[0]).not.toHaveProperty("averageResourceWaitMs");
  });

  it("rejects malformed observations before creating workspace state", () => {
    const root = workspace();
    expect(() => recordGraphSchedulingObservation(root, observation({ fingerprint: "old-definition" }))).toThrow(
      /invalid/,
    );
    expect(() =>
      recordGraphSchedulingObservation(root, observation({ recordedAt: new Date(Date.now() + 60_000).toISOString() })),
    ).toThrow(/invalid/);
    expect(existsSync(join(root, ".seekforge"))).toBe(false);
  });

  it("drops stale or extended records and rejects an extended envelope", () => {
    const root = workspace();
    const directory = join(root, ".seekforge");
    const path = join(directory, "graph-scheduling-history.json");
    mkdirSync(directory);
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        observations: [
          observation({ recordedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString() }),
          { ...observation(), forged: true },
          observation(),
        ],
      }),
    );
    expect(readGraphSchedulingObservations(root)).toEqual([expect.objectContaining({ graphId: "delivery" })]);
    writeFileSync(path, JSON.stringify({ version: 2, observations: [observation()], forged: true }));
    expect(readGraphSchedulingObservations(root)).toEqual([]);
  });

  it("evicts the oldest valid suffix before exceeding the reader byte ceiling", () => {
    const root = workspace();
    const directory = join(root, ".seekforge");
    const path = join(directory, "graph-scheduling-history.json");
    mkdirSync(directory);
    const large = observation({ graphId: `g${"x".repeat(126)}`, nodeId: `n${"y".repeat(126)}` });
    const observations: GraphSchedulingObservation[] = [];
    while (observations.length < 511) {
      const candidate = [...observations, large];
      if (Buffer.byteLength(JSON.stringify({ version: 2, observations: candidate })) > 130_700) break;
      observations.push(large);
    }
    writeFileSync(path, `${JSON.stringify({ version: 2, observations })}\n`);
    recordGraphSchedulingObservation(root, observation({ nodeId: "newest" }));
    const raw = readFileSync(path);
    expect(raw.byteLength).toBeLessThanOrEqual(128 * 1024);
    expect(readGraphSchedulingObservations(root).at(-1)?.nodeId).toBe("newest");
  });
});
