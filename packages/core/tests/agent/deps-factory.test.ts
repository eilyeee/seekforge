import { describe, expect, it } from "vitest";
import { buildAgentCoreDeps } from "../../src/agent/deps-factory.js";

describe("buildAgentCoreDeps", () => {
  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects memoryAutoApproveConfidence outside [0,1]: %s",
    (memoryAutoApproveConfidence) => {
      expect(() => buildAgentCoreDeps({ apiKey: "test", memoryAutoApproveConfidence })).toThrow(
        /memoryAutoApproveConfidence/,
      );
    },
  );

  it.each([0, 0.5, 1])("accepts memoryAutoApproveConfidence %s", (memoryAutoApproveConfidence) => {
    expect(buildAgentCoreDeps({ apiKey: "test", memoryAutoApproveConfidence }))
      .toMatchObject({ memoryAutoApproveConfidence });
  });
});
