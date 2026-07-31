import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planWorkspaceOrchestrationMaintenance } from "../../src/agent/orchestration-maintenance.js";

describe("orchestration maintenance planning", () => {
  it("previews an empty workspace without creating state", () => {
    const root = mkdtempSync(join(tmpdir(), "seekforge-maintenance-plan-"));
    try {
      expect(planWorkspaceOrchestrationMaintenance(root, { autoRollback: true })).toMatchObject({
        proposalsDiscovered: 0,
        activeRollouts: 0,
        indexRefreshRequired: true,
        actions: expect.arrayContaining([expect.stringContaining("rollback enabled")]),
      });
      expect(existsSync(join(root, ".seekforge"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
