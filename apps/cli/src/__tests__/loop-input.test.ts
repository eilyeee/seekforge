import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "vitest";
import { parseLoopDagInput, parseLoopSpeculationInput } from "../loop-input.js";

test("speculation input validates bounded unique candidates", () => {
  assert.deepEqual(
    parseLoopSpeculationInput({
      task: "repair",
      verifyCommand: "pnpm test",
      candidates: [
        { id: "minimal", guidance: "make the smallest change" },
        { id: "structural", guidance: "fix the boundary" },
      ],
    }).candidates.map((candidate) => candidate.id),
    ["minimal", "structural"],
  );
  assert.throws(
    () =>
      parseLoopSpeculationInput({
        task: "repair",
        verifyCommand: "pnpm test",
        candidates: [
          { id: "same", guidance: "one" },
          { id: "same", guidance: "two" },
        ],
      }),
    /unique safe id/,
  );
});

test("DAG input resolves workspaces and preserves valid conditions", () => {
  const workspace = resolve("/tmp", "seekforge-loop-input");
  const parsed = parseLoopDagInput(
    {
      nodes: [
        { id: "build", task: "build", verifyCommand: "pnpm test", workspace: "packages/core" },
        {
          id: "publish",
          task: "publish",
          verifyCommand: "pnpm test",
          verifierId: "publish-v1",
          dependsOn: ["build"],
          condition: { nodeId: "build", status: "passed" },
          outputPaths: ["dist/result.json"],
        },
      ],
      fanIn: { verifyCommand: "pnpm test", maxIterations: 2 },
    },
    workspace,
  );
  assert.equal(parsed.nodeWorkspaces.get("build"), resolve(workspace, "packages/core"));
  assert.deepEqual(parsed.nodes[1]?.condition, { nodeId: "build", status: "passed" });
  assert.equal(parsed.nodes[1]?.verifierId, "publish-v1");
  assert.equal(parsed.fanIn?.maxIterations, 2);
});

test("DAG input rejects semantic defects before runtime setup", () => {
  const workspace = process.cwd();
  const base = { task: "task", verifyCommand: "pnpm test" };
  let tooDeep: unknown = { nodeId: "a", status: "passed" };
  for (let index = 0; index < 9; index++) tooDeep = { not: tooDeep };
  assert.throws(() => parseLoopDagInput({ nodes: [] }, workspace), /1 to 64/);
  assert.throws(
    () =>
      parseLoopDagInput(
        {
          nodes: [
            { id: "same", ...base },
            { id: "same", ...base },
          ],
        },
        workspace,
      ),
    /unique safe id/,
  );
  assert.throws(
    () =>
      parseLoopDagInput(
        {
          nodes: [
            { id: "a", ...base },
            { id: "b", ...base, dependsOn: ["a"], condition: tooDeep },
          ],
        },
        workspace,
      ),
    /too deeply nested/,
  );
  assert.throws(
    () => parseLoopDagInput({ nodes: [{ id: "a", ...base, outputPaths: ["../escape"] }] }, workspace),
    /safe relative paths/,
  );
  assert.throws(
    () =>
      parseLoopDagInput(
        {
          nodes: [
            { id: "a", ...base, dependsOn: ["b"] },
            { id: "b", ...base, dependsOn: ["a"] },
          ],
        },
        workspace,
      ),
    /cycle/,
  );
  assert.throws(
    () => parseLoopDagInput({ nodes: [{ id: "a", ...base }], fanIn: { verifyCommand: " " } }, workspace),
    /fanIn requires/,
  );
});
