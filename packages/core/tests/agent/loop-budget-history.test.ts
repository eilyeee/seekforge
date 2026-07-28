import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  predictLoopBudgetWeight,
  readLoopBudgetHistory,
  recordLoopBudgetObservation,
} from "../../src/agent/loop-budget-history.js";

describe("Loop budget history", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses bounded matching history to predict scheduling weight", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-loop-budget-"));
    roots.push(root);
    for (let index = 0; index < 4; index++) {
      recordLoopBudgetObservation(root, {
        key: "test:pnpm-test",
        costUsd: 0.5,
        tokens: 4_000,
        durationMs: 30_000,
        passed: index !== 0,
        recordedAt: new Date().toISOString(),
      });
    }
    expect(readLoopBudgetHistory(root)).toHaveLength(4);
    expect(predictLoopBudgetWeight(root, "test:pnpm-test")).toMatchObject({ samples: 4 });
    expect(predictLoopBudgetWeight(root, "test:pnpm-test").weight).toBeGreaterThan(1);
  });
});
