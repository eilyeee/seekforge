import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLoopRecoveryObservations,
  explainLoopRecoveryStrategy,
  recordLoopRecoveryObservation,
  selectLoopRecoveryStrategy,
} from "../../src/agent/loop-recovery-policy.js";

describe("loop recovery policy", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("retains deterministic defaults until bounded evidence is mature", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-recovery-"));
    roots.push(root);
    expect(selectLoopRecoveryStrategy(root, "test")).toBe("isolate_test");
    for (let index = 0; index < 2; index++) {
      recordLoopRecoveryObservation(root, {
        category: "test",
        strategy: "replan",
        succeeded: true,
        recordedAt: new Date(Date.now() + index).toISOString(),
      });
    }
    expect(selectLoopRecoveryStrategy(root, "test")).toBe("replan");
    expect(readLoopRecoveryObservations(root)).toHaveLength(2);
  });

  it("never selects a strategy outside the failure category", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-recovery-"));
    roots.push(root);
    for (let index = 0; index < 4; index++) {
      recordLoopRecoveryObservation(root, {
        category: "compile",
        strategy: "repair_compile",
        succeeded: false,
        recordedAt: new Date(1_700_000_000_000 + index).toISOString(),
      });
    }
    expect(["repair_compile", "replan"]).toContain(selectLoopRecoveryStrategy(root, "compile"));
    expect(selectLoopRecoveryStrategy(root, "permission")).toBe("validate_environment");
    expect(selectLoopRecoveryStrategy(root, "review")).toBe("repair_review");
  });

  it("lets stale observations decay back to the deterministic default", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-recovery-"));
    roots.push(root);
    for (let index = 0; index < 3; index++) {
      recordLoopRecoveryObservation(root, {
        category: "test",
        strategy: "replan",
        succeeded: true,
        recordedAt: "2020-01-01T00:00:00.000Z",
      });
    }
    expect(selectLoopRecoveryStrategy(root, "test")).toBe("isolate_test");
  });

  it("rejects malformed public observations instead of persisting unusable policy data", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-recovery-"));
    roots.push(root);
    expect(() =>
      recordLoopRecoveryObservation(root, {
        category: "none",
        strategy: "replan",
        succeeded: true,
        recordedAt: "invalid",
      }),
    ).toThrow(/invalid/);
    expect(readLoopRecoveryObservations(root)).toEqual([]);
  });

  it("ranks context-matched low-cost observations and explains the decision", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-recovery-"));
    roots.push(root);
    for (let index = 0; index < 3; index++) {
      recordLoopRecoveryObservation(root, {
        category: "test",
        strategy: "replan",
        succeeded: true,
        recordedAt: new Date().toISOString(),
        context: { framework: "vitest", stageId: "unit" },
        costUsd: 0.01,
        durationMs: 10,
        diagnosticDelta: 2,
      });
    }
    expect(
      explainLoopRecoveryStrategy(root, "test", { context: { framework: "vitest", stageId: "unit" } }),
    ).toMatchObject({ strategy: "replan", samples: 3 });
  });
});
