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
    expect(buildAgentCoreDeps({ apiKey: "test", memoryAutoApproveConfidence })).toMatchObject({
      memoryAutoApproveConfidence,
    });
  });

  it("passes the context settings through, and only when set", () => {
    const deps = buildAgentCoreDeps({
      apiKey: "test",
      autoCompactThreshold: 0.75,
      modelContextWindows: { "local-model": 32_768 },
    });
    expect(deps).toMatchObject({ autoCompactThreshold: 0.75, modelContextWindows: { "local-model": 32_768 } });
    const bare = buildAgentCoreDeps({ apiKey: "test" });
    expect("autoCompactThreshold" in bare).toBe(false);
    expect("modelContextWindows" in bare).toBe(false);
  });

  it("rejects malformed context settings before building anything", () => {
    expect(() => buildAgentCoreDeps({ apiKey: "test", autoCompactThreshold: 0 })).toThrow(/autoCompactThreshold/);
    expect(() => buildAgentCoreDeps({ apiKey: "test", modelContextWindows: { m: -5 } })).toThrow(/modelContextWindows/);
  });
});
