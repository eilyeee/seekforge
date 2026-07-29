import { describe, expect, it } from "vitest";
import {
  orchestrationResourcesOverlap,
  selectOrchestrationReadyNodes,
} from "../../src/agent/orchestration-scheduler.js";

describe("selectOrchestrationReadyNodes", () => {
  it("ranks deterministically and respects exact resource capacities", () => {
    expect(
      selectOrchestrationReadyNodes(
        [
          { id: "low", priority: 0, resources: ["provider.deepseek"] },
          { id: "high", priority: 1, resources: ["provider.deepseek"] },
          { id: "other", score: 5, resources: ["database"] },
        ],
        [],
        3,
        { "provider.deepseek": 2 },
      ),
    ).toEqual(["high", "other", "low"]);
  });

  it("keeps parent and child reservations exclusive even when exact sharing is enabled", () => {
    expect(orchestrationResourcesOverlap("provider.deepseek", "provider.deepseek.chat")).toBe(true);
    expect(
      selectOrchestrationReadyNodes(
        [
          { id: "parent", resources: ["provider.deepseek"] },
          { id: "child", resources: ["provider.deepseek.chat"] },
        ],
        [],
        2,
        { "provider.deepseek": 2, "provider.deepseek.chat": 2 },
      ),
    ).toEqual(["child"]);
  });
});
