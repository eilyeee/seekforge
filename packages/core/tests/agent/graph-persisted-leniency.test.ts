import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphDefinitionFingerprint, parseEngineeringGraphDefinition } from "../../src/agent/graph-contract.js";
import {
  loadEngineeringGraphState,
  saveEngineeringGraphState,
  type EngineeringGraphState,
} from "../../src/agent/graph-state.js";

/**
 * `inputs` on a kind that cannot read them used to parse and be KEPT, so it is
 * inside the fingerprint of any checkpoint written that way. Rejecting it while
 * decoding stored state would make those graphs unloadable — gone from
 * `graph list`, unresumable — over a field that never did anything.
 */
describe("a rule added after a checkpoint was written cannot brick it", () => {
  const workspaces: string[] = [];
  afterEach(() => {
    for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
  });

  const legacy = {
    graphId: "legacy",
    nodes: [
      { id: "work", kind: "function", handler: "noop" },
      // A gate never read `inputs`; the old parser still kept the field.
      { id: "review", kind: "gate", dependsOn: ["work"], inputs: { from: { nodeId: "work", pointer: "/x" } } },
    ],
  };

  it("rejects it in a new definition", () => {
    expect(() => parseEngineeringGraphDefinition(legacy)).toThrow(/inputs require a kind that consumes them/);
  });

  it("still decodes it from persisted state, field intact", () => {
    const parsed = parseEngineeringGraphDefinition(legacy, 0, true);
    expect(parsed.nodes[1]?.inputs).toBeDefined();

    const workspace = mkdtempSync(join(tmpdir(), "seekforge-graph-legacy-"));
    workspaces.push(workspace);
    const state = {
      schemaVersion: 2,
      graphId: "legacy",
      fingerprint: graphDefinitionFingerprint(parsed, new Map()),
      status: "running",
      definition: parsed,
      results: [],
      events: [],
      spentCost: 0,
      spentTokens: 0,
      elapsedMs: 0,
      activeAttempts: [],
      controlSeq: 0,
      controlRunId: "run-legacy",
      priority: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    } as unknown as EngineeringGraphState;
    saveEngineeringGraphState(workspace, state);

    const loaded = loadEngineeringGraphState(workspace, "legacy");
    expect(loaded, "an existing graph must not disappear because a rule was added").not.toBeNull();
    // The fingerprint is over the parsed definition, so keeping the field is
    // what lets resume match; stripping it would look like a changed definition.
    expect(loaded?.fingerprint).toBe(graphDefinitionFingerprint(parsed, new Map()));
  });
});
