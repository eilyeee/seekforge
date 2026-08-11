import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatResponse, ToolCall, ToolResult } from "@seekforge/shared";
import type { AgentCoreDeps } from "../../src/agent/loop.js";
import type { ToolContext, ToolDispatcher } from "../../src/tools/index.js";
import { runAutoLoop, type LoopOptions, type LoopVerificationStage } from "../../src/agent/auto-loop.js";
import { parseGraphLoopOptions, MAX_GRAPH_NODE_TIMEOUT_MS } from "../../src/agent/graph-contract.js";
import { parseLoopVerificationPlan } from "../../src/agent/loop-options-contract.js";

const noopDispatcher: ToolDispatcher = {
  list: () => [],
  execute: async (_call: ToolCall, _ctx: ToolContext): Promise<ToolResult> => ({ ok: true }),
};

function deps(): AgentCoreDeps {
  const provider = {
    model: "flash",
    async chat(): Promise<ChatResponse> {
      throw new Error("the plan is invalid, so the engine must never reach the provider");
    },
    chatStream(): Promise<ChatResponse> {
      return this.chat();
    },
  };
  return { provider, dispatcher: noopDispatcher, confirm: async () => true };
}

function opts(workspace: string, verificationPlan: unknown): LoopOptions {
  return {
    task: "make it green",
    workspace,
    verifyCommand: "echo test",
    verify: async () => ({ code: 0, output: "ok" }),
    verificationPlan: verificationPlan as LoopVerificationStage[],
  };
}

/** Shape violations both call sites must reject, with the message fragment each reports. */
const REJECTED: Array<[string, unknown, RegExp]> = [
  ["an empty plan", [], /1 to 16 stages/],
  [
    "more stages than the ceiling",
    Array.from({ length: 17 }, (_, i) => ({ id: `s${i}`, command: "true" })),
    /1 to 16 stages/,
  ],
  ["a sparse array", Object.assign([], { 1: { id: "a", command: "true" }, length: 2 }), /1 to 16 stages/],
  ["a non-object stage", ["a"], /unique safe stage id/],
  ["an unsafe stage id", [{ id: "a b", command: "true" }], /unique safe stage id/],
  [
    "a duplicate stage id",
    [
      { id: "a", command: "true" },
      { id: "a", command: "false" },
    ],
    /unique safe stage id/,
  ],
  ["a blank command", [{ id: "a", command: "   " }], /bounded command/],
  ["an oversized command", [{ id: "a", command: "x".repeat(8_193) }], /bounded command/],
  ["a non-boolean required flag", [{ id: "a", command: "true", required: "yes" }], /required must be boolean/],
  ["a non-boolean cacheable flag", [{ id: "a", command: "true", cacheable: 1 }], /cacheable must be boolean/],
  ["an empty paths list", [{ id: "a", command: "true", paths: [] }], /unique prefixes/],
  ["duplicate path prefixes", [{ id: "a", command: "true", paths: ["src", "src"] }], /unique prefixes/],
  ["an absolute path prefix", [{ id: "a", command: "true", paths: ["/etc"] }], /invalid relative prefix/],
  ["an escaping path prefix", [{ id: "a", command: "true", paths: ["../outside"] }], /invalid relative prefix/],
  [
    "dependencyPaths outside paths",
    [{ id: "a", command: "true", paths: ["src"], dependencyPaths: ["docs"] }],
    /subset of paths/,
  ],
  ["a self dependency", [{ id: "a", command: "true", dependsOn: ["a"] }], /depends on an unknown stage/],
  ["an unknown dependency", [{ id: "a", command: "true", dependsOn: ["ghost"] }], /depends on an unknown stage/],
  ["a duplicated dependency", [{ id: "a", command: "true", dependsOn: ["b", "b"] }], /unique safe stage ids/],
  ["an unsafe dependency id", [{ id: "a", command: "true", dependsOn: ["b c"] }], /unique safe stage ids/],
  [
    "a dependency cycle",
    [
      { id: "a", command: "true", dependsOn: ["b"] },
      { id: "b", command: "true", dependsOn: ["a"] },
    ],
    /stage dependency cycle/,
  ],
  [
    "an unsafe resource name",
    [{ id: "a", command: "true", resources: ["not a resource"] }],
    /resources must be unique safe names/,
  ],
  [
    "duplicate resources",
    [{ id: "a", command: "true", resources: ["db", "db"] }],
    /resources must be unique safe names/,
  ],
  ["parallel without resources", [{ id: "a", command: "true", parallel: true }], /parallel requires resources/],
  ["a fractional timeout", [{ id: "a", command: "true", timeoutMs: 1.5 }], /timeoutMs/],
  ["a zero timeout", [{ id: "a", command: "true", timeoutMs: 0 }], /timeoutMs/],
];

const ACCEPTED: unknown = [
  { id: "unit", command: "pnpm test", paths: ["src", "tests"], dependencyPaths: ["src"], cacheable: true },
  { id: "lint", command: "pnpm lint", required: false, timeoutMs: 60_000, dependsOn: ["unit"] },
  { id: "e2e", command: "pnpm e2e", parallel: true, resources: ["browser"], dependsOn: ["unit", "lint"] },
];

describe("Loop verification plan contract", () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-plan-contract-"));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  for (const [what, plan, message] of REJECTED) {
    it(`rejects ${what} in the engine, in a graph node, and in the shared parser`, async () => {
      expect(() => parseLoopVerificationPlan(plan, { label: "Loop verificationPlan" })).toThrow(message);
      expect(() => parseGraphLoopOptions({ verificationPlan: plan })).toThrow(message);
      await expect(runAutoLoop(deps(), opts(workspace, plan))).rejects.toThrow(message);
      // Pure validation precedes every effect: nothing was persisted.
      expect(readdirSync(workspace)).toEqual([]);
    });
  }

  it("accepts the same fully-featured plan on both sides", () => {
    const fromEngineRules = parseLoopVerificationPlan(ACCEPTED, { label: "Loop verificationPlan" });
    const fromGraph = parseGraphLoopOptions({ verificationPlan: ACCEPTED }).verificationPlan;
    expect(fromGraph).toEqual(fromEngineRules);
    expect(fromEngineRules.map((stage) => stage.id)).toEqual(["unit", "lint", "e2e"]);
  });

  describe("deliberate differences between the two call sites", () => {
    it("only the graph rejects unknown stage fields (a resumed plan may be newer)", () => {
      const plan = [{ id: "a", command: "true", futureField: 1 }];
      expect(() => parseGraphLoopOptions({ verificationPlan: plan })).toThrow(/unsupported field: futureField/);
      expect(() => parseLoopVerificationPlan(plan, { label: "Loop verificationPlan" })).not.toThrow();
    });

    it("only the graph caps a stage timeout; the engine requires a positive safe integer", () => {
      const plan = [{ id: "a", command: "true", timeoutMs: MAX_GRAPH_NODE_TIMEOUT_MS + 1 }];
      expect(() => parseGraphLoopOptions({ verificationPlan: plan })).toThrow(/timeoutMs must be an integer from 1 to/);
      expect(() => parseLoopVerificationPlan(plan, { label: "Loop verificationPlan" })).not.toThrow();
      expect(() =>
        parseLoopVerificationPlan(plan, { label: "Loop verificationPlan", maxTimeoutMs: MAX_GRAPH_NODE_TIMEOUT_MS }),
      ).toThrow(/timeoutMs must be an integer from 1 to/);
    });

    it("repairs a replayed plan the strict rules would reject", () => {
      // Both rules are new on the engine path. A checkpoint written by a build
      // that did not have them must still decode, or resume strands it.
      const dupes = [{ id: "a", command: "true", paths: ["src/", "src/"] }];
      expect(() => parseLoopVerificationPlan(dupes, { label: "Loop verificationPlan" })).toThrow(/unique prefixes/);
      expect(parseLoopVerificationPlan(dupes, { label: "Loop verificationPlan", replayed: true })).toEqual([
        { id: "a", command: "true", paths: ["src/"] },
      ]);

      const notBoolean = [{ id: "a", command: "true", required: 1 }];
      expect(() => parseLoopVerificationPlan(notBoolean, { label: "Loop verificationPlan" })).toThrow(
        /required must be boolean/,
      );
      expect(parseLoopVerificationPlan(notBoolean, { label: "Loop verificationPlan", replayed: true })).toEqual([
        { id: "a", command: "true" },
      ]);

      // …and a replayed plan that is genuinely unrunnable is still rejected.
      expect(() =>
        parseLoopVerificationPlan([{ id: "a", command: "" }], { label: "Loop verificationPlan", replayed: true }),
      ).toThrow(/requires a bounded command/);
    });

    it("resumes a checkpoint carrying a plan the strict rules would reject", async () => {
      // The engine picks strictness by source, so this is the rule that matters:
      // handed in now → strict; read back from resumeState → repaired.
      const plan = [{ id: "a", command: "true", paths: ["src/", "src/"] }] as unknown as LoopVerificationStage[];
      await expect(runAutoLoop(deps(), opts(workspace, plan))).rejects.toThrow(/unique prefixes/);
      const resumed = runAutoLoop(deps(), {
        ...opts(workspace, plan),
        verificationPlan: undefined,
        resumeState: { verificationPlan: plan },
      } as unknown as LoopOptions);
      // Not merely a different error — the replayed plan runs.
      await expect(resumed).resolves.toBeDefined();
    });

    it("normalizes away unknown fields it tolerates", () => {
      const [stage] = parseLoopVerificationPlan([{ id: "a", command: "true", futureField: 1 }], {
        label: "Loop verificationPlan",
      });
      expect(stage).toEqual({ id: "a", command: "true" });
    });
  });
});
