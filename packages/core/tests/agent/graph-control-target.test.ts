import { describe, expect, it } from "vitest";
import { checkGraphControlTarget } from "../../src/agent/graph-control-store.js";
import { checkGraphSignalTarget } from "../../src/agent/graph-signal-store.js";
import type { EngineeringGraphState } from "../../src/agent/graph-state.js";

function state(overrides: Partial<EngineeringGraphState> = {}): EngineeringGraphState {
  return {
    graphId: "release",
    status: "running",
    controlRunId: "run-1",
    definition: {
      graphId: "release",
      nodes: [
        { id: "implement", kind: "agent", task: "work" },
        { id: "await-release", kind: "wait", waitFor: { signal: "approved" } },
        { id: "verify", kind: "gate" },
      ],
    },
    results: [],
    activeAttempts: [],
    ...overrides,
  } as unknown as EngineeringGraphState;
}

describe("Graph control and signal admissibility", () => {
  it("accepts a graph-wide command on a live run", () => {
    expect(checkGraphControlTarget(state(), { operation: "pause" })).toBeUndefined();
    expect(checkGraphControlTarget(state(), { operation: "steer", message: "prefer the smaller fix" })).toBeUndefined();
  });

  it("refuses control unless the run is live and owns a control id", () => {
    expect(checkGraphControlTarget(state({ status: "paused" }), { operation: "pause" })).toMatchObject({
      code: "not_running",
    });
    expect(checkGraphControlTarget(state({ controlRunId: "" }), { operation: "pause" })).toMatchObject({
      code: "not_running",
    });
  });

  it("rejects a node that the definition does not declare", () => {
    expect(checkGraphControlTarget(state(), { operation: "cancel", nodeId: "absent" })).toMatchObject({
      code: "bad_request",
      message: expect.stringContaining("absent"),
    });
  });

  it("refuses node control once that node has started or settled", () => {
    const settled = state({ results: [{ id: "implement", status: "passed" }] as never });
    expect(checkGraphControlTarget(settled, { operation: "cancel", nodeId: "implement" })).toMatchObject({
      code: "conflict",
    });
    const active = state({ activeAttempts: [{ nodeId: "implement", attempt: 1 }] as never });
    expect(
      checkGraphControlTarget(active, { operation: "reprioritize", nodeId: "implement", priority: 3 }),
    ).toMatchObject({ code: "conflict" });
    // A pending peer of a started node stays controllable.
    expect(checkGraphControlTarget(active, { operation: "cancel", nodeId: "verify" })).toBeUndefined();
  });

  it("requires a node id for node-scoped operations", () => {
    expect(checkGraphControlTarget(state(), { operation: "cancel", nodeId: undefined } as never)).toMatchObject({
      code: "bad_request",
    });
  });

  it("accepts only a signal that a wait node declares", () => {
    expect(checkGraphSignalTarget(state(), "approved")).toBeUndefined();
    expect(checkGraphSignalTarget(state(), "undeclared")).toMatchObject({ code: "bad_request" });
    expect(checkGraphSignalTarget(state(), "not a safe id")).toMatchObject({ code: "bad_request" });
  });

  it("accepts a signal while wait-paused but not while paused for another reason", () => {
    expect(checkGraphSignalTarget(state({ status: "paused", pauseReason: "wait" }), "approved")).toBeUndefined();
    expect(checkGraphSignalTarget(state({ status: "paused", pauseReason: "approval" }), "approved")).toMatchObject({
      code: "conflict",
    });
    expect(checkGraphSignalTarget(state({ status: "passed" }), "approved")).toMatchObject({ code: "conflict" });
  });
});
