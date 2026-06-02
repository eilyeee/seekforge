import { afterEach, describe, expect, it, vi } from "vitest";

// The TUI factory must reach config parity with the CLI: the flat documented
// `planModel` key (taking precedence over the back-compat nested
// `routing.planModel`) and `memoryAutoApproveConfidence` must reach core's
// createAgentCore deps. We mock core to capture the deps rather than build a
// real agent.
const createAgentCore = vi.fn(() => ({}) as never);

vi.mock("@seekforge/core", async () => {
  const actual = await vi.importActual<typeof import("@seekforge/core")>("@seekforge/core");
  return {
    ...actual,
    createAgentCore,
    createDeepSeekProvider: vi.fn(() => ({}) as never),
    createDefaultDispatcher: vi.fn(() => ({}) as never),
    createRetryBus: vi.fn(() => ({ onRetry: vi.fn() }) as never),
  };
});

const { createTuiAgent } = await import("../agent/factory.js");

const baseOpts = {
  confirm: vi.fn(),
  extractMemory: false,
};

afterEach(() => createAgentCore.mockClear());

describe("createTuiAgent config parity", () => {
  it("forwards the flat documented planModel key", () => {
    createTuiAgent({ ...baseOpts, config: { planModel: "deepseek-v4-pro" } } as never);
    expect(createAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({ planModel: "deepseek-v4-pro" }),
    );
  });

  it("keeps the nested routing.planModel working for back-compat", () => {
    createTuiAgent({ ...baseOpts, config: { routing: { planModel: "nested-model" } } } as never);
    expect(createAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({ planModel: "nested-model" }),
    );
  });

  it("lets the flat planModel take precedence over the nested one", () => {
    createTuiAgent({
      ...baseOpts,
      config: { planModel: "flat-model", routing: { planModel: "nested-model" } },
    } as never);
    expect(createAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({ planModel: "flat-model" }),
    );
  });

  it("forwards memoryAutoApproveConfidence when set", () => {
    createTuiAgent({ ...baseOpts, config: { memoryAutoApproveConfidence: 0.9 } } as never);
    expect(createAgentCore).toHaveBeenCalledWith(
      expect.objectContaining({ memoryAutoApproveConfidence: 0.9 }),
    );
  });

  it("omits planModel and memoryAutoApproveConfidence when unset", () => {
    createTuiAgent({ ...baseOpts, config: {} } as never);
    const deps = (createAgentCore.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(deps).not.toHaveProperty("planModel");
    expect(deps).not.toHaveProperty("memoryAutoApproveConfidence");
  });
});
