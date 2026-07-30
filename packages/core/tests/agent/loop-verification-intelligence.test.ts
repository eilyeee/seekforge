import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeLoopVerificationIntelligence,
  loopVerificationIntelligenceScore,
  readLoopVerificationIntelligence,
  recordLoopVerificationIntelligence,
  summarizeLoopVerificationReliability,
} from "../../src/agent/loop-verification-intelligence.js";

describe("Loop verification intelligence", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  const result = (code: number, flaky = false, durationMs = 100) => ({
    id: "tests",
    command: "pnpm test",
    code,
    output: "not persisted",
    attempts: flaky ? 2 : 1,
    flaky,
    durationMs,
  });

  it("retains bounded outcome statistics without verifier output", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    recordLoopVerificationIntelligence(workspace, result(1, false, 100), "test");
    recordLoopVerificationIntelligence(workspace, result(0, true, 300), "none");
    const entry = recordLoopVerificationIntelligence(workspace, result(0, false, 200), "none");
    expect(entry).toMatchObject({
      samples: 3,
      passes: 2,
      failures: 1,
      flakyRuns: 1,
      consecutiveFailures: 0,
      averageDurationMs: 200,
      lastFailureCategory: "none",
    });
    const raw = readFileSync(join(workspace, ".seekforge", "loop-verification-intelligence.json"), "utf8");
    expect(raw).not.toContain("not persisted");
  });

  it("fails closed on unknown fields and reports sustained anomalies", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    for (let index = 0; index < 4; index++) {
      const flakyPass = index < 2;
      recordLoopVerificationIntelligence(workspace, result(flakyPass ? 0 : 1, flakyPass), flakyPass ? "none" : "test");
    }
    const entries = readLoopVerificationIntelligence(workspace);
    expect(loopVerificationIntelligenceScore(entries[0])).toBeGreaterThan(0);
    expect(analyzeLoopVerificationIntelligence(entries).map((finding) => finding.kind)).toEqual([
      "failure_streak",
      "failure_rate",
      "flaky",
    ]);

    const path = join(workspace, ".seekforge", "loop-verification-intelligence.json");
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    persisted.entries[0].forged = true;
    writeFileSync(path, JSON.stringify(persisted));
    expect(readLoopVerificationIntelligence(workspace)).toEqual([]);
  });

  it("rejects contradictory or loosely typed observations before creating state", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    expect(() => recordLoopVerificationIntelligence(workspace, result(0), "test")).toThrow(/invalid/);
    expect(() =>
      recordLoopVerificationIntelligence(workspace, { ...result(1), flaky: "yes" } as never, "test"),
    ).toThrow(/invalid/);
    expect(() =>
      recordLoopVerificationIntelligence(workspace, { ...result(0, true), id: "../escape", attempts: 1 }, "none"),
    ).toThrow(/invalid/);
    expect(readLoopVerificationIntelligence(workspace)).toEqual([]);
    expect(existsSync(join(workspace, ".seekforge"))).toBe(false);
  });

  it("keeps averages and scheduler scores safe for extreme valid durations", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    recordLoopVerificationIntelligence(workspace, result(1, false, Number.MAX_SAFE_INTEGER), "test");
    const entry = recordLoopVerificationIntelligence(workspace, result(1, false, 1), "test");
    expect(Number.isSafeInteger(entry.averageDurationMs)).toBe(true);
    expect(Number.isSafeInteger(loopVerificationIntelligenceScore(entry))).toBe(true);
  });

  it("derives confidence-aware retry and quarantine advice", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    for (let index = 0; index < 8; index++) {
      recordLoopVerificationIntelligence(workspace, result(0, true), "none");
    }
    const reliability = summarizeLoopVerificationReliability(readLoopVerificationIntelligence(workspace)[0]!);
    expect(reliability).toMatchObject({
      confidence: "medium",
      recommendedAttempts: 3,
      quarantineCandidate: true,
    });
    expect(
      summarizeLoopVerificationReliability(
        { ...readLoopVerificationIntelligence(workspace)[0]!, updatedAt: "2020-01-01T00:00:00.000Z" },
        Date.parse("2026-01-01T00:00:00.000Z"),
      ),
    ).toMatchObject({ confidence: "low", recommendedAttempts: 1, quarantineCandidate: false, ageWeight: 0 });
  });

  it("evicts oldest entries before the writer exceeds its own byte limit", () => {
    const workspace = mkdtempSync(join(tmpdir(), "seekforge-loop-intelligence-"));
    workspaces.push(workspace);
    recordLoopVerificationIntelligence(workspace, result(0), "none");
    const path = join(workspace, ".seekforge", "loop-verification-intelligence.json");
    const base = JSON.parse(readFileSync(path, "utf8")).entries[0];
    const entries: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 70; index++) {
      const candidate = [
        ...entries,
        { ...base, stageId: `tests-${index}`, command: `pnpm test ${index} ${"x".repeat(8_000)}` },
      ];
      if (Buffer.byteLength(JSON.stringify({ version: 1, entries: candidate })) > 524_200) break;
      entries.push(candidate.at(-1));
    }
    writeFileSync(path, `${JSON.stringify({ version: 1, entries })}\n`);
    recordLoopVerificationIntelligence(
      workspace,
      { ...result(0), id: "tests-newest", command: `pnpm test newest ${"x".repeat(8_000)}` },
      "none",
    );
    const raw = readFileSync(path);
    expect(raw.byteLength).toBeLessThanOrEqual(512 * 1024);
    const retained = readLoopVerificationIntelligence(workspace);
    expect(retained.length).toBeLessThan(entries.length + 1);
    expect(retained.at(-1)?.stageId).toBe("tests-newest");
  });
});
