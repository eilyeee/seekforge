import { describe, expect, it } from "vitest";
import type { EngineeringGraphState } from "@seekforge/core";
import {
  formatGraphListLines,
  formatGraphShowLines,
  parseGraphId,
  parseGraphRest,
  parseGraphSignal,
} from "../graph-cmd.js";

/**
 * Minimal persisted-Graph fixture. Only the fields the formatters read are
 * populated; the cast keeps the test focused on presentation rather than on
 * reproducing the whole checkpoint schema (graph-state.ts owns that).
 */
function state(overrides: Partial<EngineeringGraphState> = {}): EngineeringGraphState {
  return {
    graphId: "graph-1",
    status: "running",
    definition: { nodes: [{ id: "plan" }, { id: "build" }, { id: "verify" }] },
    results: [],
    spentCost: 0,
    spentTokens: 0,
    priority: 0,
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  } as unknown as EngineeringGraphState;
}

describe("parseGraphId", () => {
  it("accepts a single well-formed graph id", () => {
    expect(parseGraphId("graph-1")).toBe("graph-1");
    expect(parseGraphId("  graph-1  ")).toBe("graph-1");
  });

  it("rejects a missing, malformed or multi-word argument", () => {
    expect(parseGraphId(undefined)).toBeNull();
    expect(parseGraphId("")).toBeNull();
    expect(parseGraphId("graph 1")).toBeNull();
    expect(parseGraphId("../escape")).toBeNull();
  });
});

describe("parseGraphRest", () => {
  it("splits the id from the free-text operand", () => {
    expect(parseGraphRest("graph-1 rerun the failing node")).toEqual({
      graphId: "graph-1",
      rest: "rerun the failing node",
    });
  });

  it("keeps the operand's internal spacing and trims the edges", () => {
    expect(parseGraphRest("graph-1   focus on  the parser  ")).toEqual({
      graphId: "graph-1",
      rest: "focus on  the parser",
    });
  });

  it("requires both an id and an operand", () => {
    expect(parseGraphRest("graph-1")).toBeNull();
    expect(parseGraphRest("")).toBeNull();
    expect(parseGraphRest(undefined)).toBeNull();
    expect(parseGraphRest("../escape guidance")).toBeNull();
  });
});

describe("parseGraphSignal", () => {
  it("takes exactly an id and a name", () => {
    expect(parseGraphSignal("graph-1 deploy-ok")).toEqual({ graphId: "graph-1", name: "deploy-ok" });
  });

  it("rejects anything that is not two words", () => {
    expect(parseGraphSignal("graph-1")).toBeNull();
    expect(parseGraphSignal("graph-1 deploy-ok extra")).toBeNull();
    expect(parseGraphSignal(undefined)).toBeNull();
  });

  it("leaves signal-name validity to checkGraphSignalTarget", () => {
    // A name that is not a declared wait signal still parses; core rejects it
    // with the message the user should see, so the TUI must not pre-empt it.
    expect(parseGraphSignal("graph-1 NOT_A_SIGNAL")).toEqual({ graphId: "graph-1", name: "NOT_A_SIGNAL" });
  });
});

describe("formatGraphListLines", () => {
  it("explains an empty workspace", () => {
    expect(formatGraphListLines([])).toEqual(["no persisted Graphs"]);
  });

  it("renders one row per Graph with the pause reason", () => {
    expect(
      formatGraphListLines([
        state(),
        state({
          graphId: "graph-2",
          status: "paused",
          pauseReason: "approval",
          priority: 3,
          results: [{ id: "plan" }] as unknown as EngineeringGraphState["results"],
          updatedAt: "2026-08-09T00:00:00.000Z",
        }),
      ]),
    ).toEqual([
      "graph-1 · running · 0/3 nodes · priority 0 · 2026-08-10T00:00:00.000Z",
      "graph-2 · paused (approval) · 1/3 nodes · priority 3 · 2026-08-09T00:00:00.000Z",
    ]);
  });

  it("caps the listing and summarizes the overflow", () => {
    const many = Array.from({ length: 23 }, (_, i) => state({ graphId: `graph-${i}` }));
    const lines = formatGraphListLines(many);
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe("… 3 more Graphs (/graph-show <graph-id>)");
  });

  it("preserves the order it is given", () => {
    const lines = formatGraphListLines([state({ graphId: "graph-b" }), state({ graphId: "graph-a" })]);
    expect(lines[0]?.startsWith("graph-b ")).toBe(true);
    expect(lines[1]?.startsWith("graph-a ")).toBe(true);
  });
});

describe("formatGraphShowLines", () => {
  it("renders the header, totals and per-node markers", () => {
    expect(
      formatGraphShowLines(
        state({
          spentCost: 0.125,
          spentTokens: 4_200,
          priority: 2,
          results: [
            { id: "plan", status: "passed" },
            { id: "build", status: "failed", error: "exit 1" },
            { id: "verify", status: "waiting_approval" },
          ] as unknown as EngineeringGraphState["results"],
        }),
      ),
    ).toEqual([
      "graph-1 · running",
      "  nodes 3/3 · $0.1250 · 4200 tokens · priority 2",
      "  updated 2026-08-10T00:00:00.000Z",
      "  ✓ plan · passed",
      "  ✗ build · failed — exit 1",
      "  · verify · waiting_approval",
    ]);
  });

  it("caps node lines and counts the remainder", () => {
    const results = Array.from({ length: 22 }, (_, i) => ({ id: `n${i}`, status: "passed" }));
    const lines = formatGraphShowLines(state({ results: results as unknown as EngineeringGraphState["results"] }));
    expect(lines).toHaveLength(3 + 20 + 1);
    expect(lines.at(-1)).toBe("  … 2 more nodes");
  });

  it("clips a long node error", () => {
    const lines = formatGraphShowLines(
      state({
        results: [
          { id: "build", status: "failed", error: "e".repeat(200) },
        ] as unknown as EngineeringGraphState["results"],
      }),
    );
    expect(lines.at(-1)?.length).toBeLessThan(120);
  });
});
