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

  it.each(["off", "project", "all"] as const)("passes claudeCompat %s through", (claudeCompat) => {
    expect(buildAgentCoreDeps({ apiKey: "test", claudeCompat })).toMatchObject({ claudeCompat });
  });

  it("omits claudeCompat when unset and rejects an unknown mode", () => {
    expect(buildAgentCoreDeps({ apiKey: "test" })).not.toHaveProperty("claudeCompat");
    expect(() => buildAgentCoreDeps({ apiKey: "test", claudeCompat: "yes" as never })).toThrow(/claudeCompat/);
  });
});

describe("buildAgentCoreDeps sandbox network and additional directories", () => {
  const allowlist = { allowedDomains: ["registry.npmjs.org", "*.github.com"] };

  it("keeps a plain sandbox level and drops off/absent", () => {
    expect(buildAgentCoreDeps({ apiKey: "test", sandbox: "restricted" }).sandbox).toBe("restricted");
    expect(buildAgentCoreDeps({ apiKey: "test", sandbox: "off" })).not.toHaveProperty("sandbox");
    expect(buildAgentCoreDeps({ apiKey: "test" })).not.toHaveProperty("sandbox");
  });

  it("folds a validated allowlist into the sandbox, implying workspace-write when no level is set", () => {
    expect(buildAgentCoreDeps({ apiKey: "test", sandboxNetwork: allowlist }).sandbox).toEqual({
      filesystem: "workspace-write",
      network: allowlist,
      writablePaths: [],
    });
    expect(
      buildAgentCoreDeps({ apiKey: "test", sandbox: "read-only", sandboxNetwork: allowlist }).sandbox,
    ).toMatchObject({ filesystem: "read-only", network: allowlist });
    expect(
      buildAgentCoreDeps({ apiKey: "test", sandbox: "restricted", sandboxNetwork: allowlist }).sandbox,
    ).toMatchObject({ network: "deny" });
    expect(buildAgentCoreDeps({ apiKey: "test", sandbox: "off", sandboxNetwork: allowlist })).not.toHaveProperty(
      "sandbox",
    );
  });

  it("refuses a malformed allowlist instead of leaving the network open", () => {
    for (const sandboxNetwork of [{ allowedDomains: ["https://x.dev"] }, ["x.dev"], { allowedDomains: ["*"] }]) {
      expect(() => buildAgentCoreDeps({ apiKey: "test", sandbox: "workspace-write", sandboxNetwork })).toThrow(
        /sandboxNetwork/,
      );
    }
  });

  it("passes additional directories through only when there are some", () => {
    expect(buildAgentCoreDeps({ apiKey: "test", additionalDirectories: ["/a"] }).additionalDirectories).toEqual(["/a"]);
    expect(buildAgentCoreDeps({ apiKey: "test", additionalDirectories: [] })).not.toHaveProperty(
      "additionalDirectories",
    );
  });
});
