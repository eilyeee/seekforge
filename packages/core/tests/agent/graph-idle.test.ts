import { describe, expect, it, vi } from "vitest";
import { createGraphMaintenanceScheduler } from "../../src/agent/graph-idle.js";

describe("createGraphMaintenanceScheduler", () => {
  it("runs targets sequentially and isolates target failures", async () => {
    const order: string[] = [];
    const scheduler = createGraphMaintenanceScheduler({
      initialDelayMs: 1_000,
      intervalMs: 1_000,
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
      targets: () => [
        {
          workspace: "/first",
          maintain: async () => {
            order.push("first");
            return [];
          },
        },
        {
          workspace: "/second",
          maintain: async () => {
            order.push("second");
            throw new Error("maintenance failed");
          },
        },
      ],
    });
    const result = await scheduler.checkNow();
    expect(order).toEqual(["first", "second"]);
    expect(result).toEqual([
      { workspace: "/first", outcome: { status: "completed", states: [] } },
      { workspace: "/second", outcome: { status: "failed", error: "maintenance failed" } },
    ]);
    scheduler.dispose();
  });

  it("rejects timer overflow before scheduling", () => {
    expect(() =>
      createGraphMaintenanceScheduler({
        targets: () => [],
        initialDelayMs: 2_147_483_648,
      }),
    ).toThrow(/initialDelayMs/);
  });
});
