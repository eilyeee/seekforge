import { describe, expect, it } from "vitest";
import {
  buildLoopEvidenceReport,
  compareLoopEvidence,
  exportLoopEvidence,
  verifyLoopEvidenceIntegrity,
} from "../../src/agent/loop-evidence.js";
import type { LoopState } from "../../src/agent/loop-state.js";

describe("buildLoopEvidenceReport", () => {
  it("links acceptance criteria, verifier results, iterations, and delivery evidence", () => {
    const state = {
      loopId: "evidence",
      task: "ship",
      workspace: "/repo",
      verifyCommand: "pnpm test",
      maxIterations: 2,
      costBudgetUsd: null,
      iterations: 1,
      costUsd: 0.1,
      sessionId: "s1",
      lastVerify: { code: 0, output: "ok" },
      status: "passed",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      requirementMode: "analyze",
      requirements: {
        version: 1,
        goal: "ship",
        deliverables: ["code"],
        requirements: [{ id: "R1", text: "works", required: true }],
        constraints: [],
        outOfScope: [],
        assumptions: [],
        acceptanceCriteria: [{ id: "A1", text: "tests pass", requirementIds: ["R1"] }],
        unresolvedQuestions: [],
      },
      acceptanceReview: {
        complete: true,
        criteria: [{ id: "A1", status: "met", evidence: ["path:a.ts#L1"] }],
        gaps: [],
      },
      stageResults: [
        {
          id: "test",
          command: "pnpm test",
          code: 0,
          output: "ok",
          attempts: 1,
          flaky: false,
          durationMs: 12,
          selection: "dependency",
          matchedPaths: ["packages/lib/a.ts"],
        },
      ],
      verificationPlan: [
        { id: "test", command: "pnpm test", paths: ["apps/web", "packages/lib"], dependencyPaths: ["packages/lib"] },
      ],
      snapshots: [
        {
          iteration: 1,
          ts: "2026-01-01T00:00:01.000Z",
          diagnosticsFingerprint: "x",
          workspaceFingerprint: "y",
          failedTests: 0,
          stageResults: [],
        },
      ],
    } satisfies LoopState;
    const report = buildLoopEvidenceReport(state, new Date("2026-01-02T00:00:00.000Z"));
    expect(report.criteria[0]).toMatchObject({ id: "A1", status: "met" });
    expect(report.verification[0]).toMatchObject({ code: 0, selection: "dependency" });
    expect(report.iterations).toHaveLength(1);
    expect(report.usage).toEqual({ costUsd: 0.1, tokensUsed: 0, iterations: 1 });
    expect(report.integrity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLoopEvidenceIntegrity(report)).toBe(true);
    expect(verifyLoopEvidenceIntegrity(null)).toBe(false);
    expect(verifyLoopEvidenceIntegrity({ ...report, task: "tampered" })).toBe(false);
    expect(JSON.parse(exportLoopEvidence(report, "sarif"))).toMatchObject({ version: "2.1.0" });
    expect(exportLoopEvidence(report, "junit")).toContain("<testsuite");
    expect(compareLoopEvidence(report, { ...report, status: "exhausted", iterations: [] })).toMatchObject({
      statusChanged: true,
      iterationDelta: -1,
    });
    expect(
      compareLoopEvidence(report, {
        ...report,
        verification: report.verification.map((stage) => ({ ...stage, command: "pnpm test --changed" })),
      }).verificationChanged,
    ).toEqual(["test"]);
    const pending = { ...report, verification: report.verification.map(({ code: _code, ...stage }) => stage) };
    expect(JSON.parse(exportLoopEvidence(pending, "sarif")).runs[0].results).toEqual([
      expect.objectContaining({ ruleId: "verification/test", level: "warning" }),
    ]);
  });
});
