import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLoopState, saveLoopState } from "../../src/agent/loop-state.js";
import {
  buildWorkspaceContextualLoopRoutingProfile,
  loopRoutingContext,
  selectWorkspaceContextualLoopRoutes,
} from "../../src/agent/orchestration-routing.js";

describe("contextual Loop routing", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("classifies mixed toolchains without substring false positives", () => {
    expect(loopRoutingContext("fix a cargo build", "cargo test")).toBe("rust");
    expect(loopRoutingContext("fix node bindings", "cargo test && pnpm test")).toBe("mixed");
    expect(loopRoutingContext("algorithm", "make test")).toBe("generic");
  });

  it("selects a deterministic route from durable post-edit evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-contextual-route-"));
    roots.push(root);
    const state = createLoopState({
      loopId: "route",
      task: "repair TypeScript tests",
      workspace: root,
      verifyCommand: "pnpm test",
      maxIterations: 5,
    });
    const snapshots = [
      { iteration: 0, failedTests: 3, failureCategory: "test" as const },
      { iteration: 1, failedTests: 2, failureCategory: "test" as const, editModel: "model-a" },
      { iteration: 2, failedTests: 1, failureCategory: "test" as const, editModel: "model-a" },
      { iteration: 3, failedTests: 0, failureCategory: "none" as const, editModel: "model-a" },
    ].map((snapshot) => ({
      ts: "2026-01-01T00:00:00.000Z",
      diagnosticsFingerprint: "a".repeat(64),
      workspaceFingerprint: null,
      stageResults: [],
      ...snapshot,
    }));
    saveLoopState(root, { ...state, snapshots });
    expect(buildWorkspaceContextualLoopRoutingProfile(root)).toMatchObject({ loops: 1, samples: 3 });
    expect(selectWorkspaceContextualLoopRoutes(root, state, { minimumSamples: 3, explorationRate: 0 })).toEqual({
      test: "model-a",
    });
  });
});
