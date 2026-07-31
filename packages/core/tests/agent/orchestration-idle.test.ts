import { describe, expect, it, vi } from "vitest";
import { createOrchestrationMaintenanceScheduler } from "../../src/agent/orchestration-idle.js";

describe("createOrchestrationMaintenanceScheduler", () => {
  it("runs targets sequentially, reports busy, and isolates failures", async () => {
    const order: string[] = [];
    const scheduler = createOrchestrationMaintenanceScheduler({
      targets: () => [
        { workspace: "/busy", maintain: async () => undefined },
        {
          workspace: "/failed",
          maintain: async () => {
            order.push("failed");
            throw new Error("maintenance failed");
          },
        },
      ],
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
    });
    expect(await scheduler.checkNow()).toEqual([
      { workspace: "/busy", outcome: { status: "busy" } },
      { workspace: "/failed", outcome: { status: "failed", error: "maintenance failed" } },
    ]);
    expect(order).toEqual(["failed"]);
    scheduler.dispose();
  });

  it("rejects an overflowing timer before scheduling", () => {
    expect(() => createOrchestrationMaintenanceScheduler({ targets: () => [], intervalMs: 2_147_483_648 })).toThrow(
      /intervalMs/,
    );
  });
});
