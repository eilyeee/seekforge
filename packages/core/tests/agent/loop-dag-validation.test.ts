import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  assertValidLoopDagNodes,
  isSafeLoopDagRelativePath,
  isValidLoopDagId,
  parseLoopDagCondition,
} from "../../src/agent/loop-dag-validation.js";

const base = { task: "task", verifyCommand: "pnpm test" };

describe("Loop DAG contract validation", () => {
  test("accepts one complete graph through the shared validator", () => {
    assert.doesNotThrow(() =>
      assertValidLoopDagNodes([
        { id: "build", ...base, outputPaths: ["dist/result.json"] },
        {
          id: "publish",
          ...base,
          dependsOn: ["build"],
          condition: { nodeId: "build", status: "passed" },
          verifierId: "publish-v1",
        },
      ]),
    );
  });

  test("rejects duplicate dependencies and unsafe path bytes for every caller", () => {
    assert.equal(isValidLoopDagId(123), false);
    assert.throws(
      () =>
        assertValidLoopDagNodes([
          { id: "build", ...base },
          { id: "publish", ...base, dependsOn: ["build", "build"] },
        ]),
      /invalid dependencies/,
    );
    assert.equal(isSafeLoopDagRelativePath("dist/result\0.json"), false);
    assert.throws(
      () => assertValidLoopDagNodes([{ id: "build", ...base, outputPaths: ["dist/result\0.json"] }]),
      /safe relative paths/,
    );
    assert.throws(
      () => assertValidLoopDagNodes([{ id: "build", ...base, verifierId: 123 as unknown as string }]),
      /verifierId must be safe/,
    );
    assert.throws(
      () =>
        assertValidLoopDagNodes([
          { id: "build", ...base },
          {
            id: "publish",
            ...base,
            dependsOn: ["build"],
            condition: { nodeId: 123, status: "passed" } as unknown as {
              nodeId: string;
              status: "passed";
            },
          },
        ]),
      /condition must reference/,
    );
  });

  test("shares bounded condition decoding with transport adapters", () => {
    assert.deepEqual(parseLoopDagCondition({ any: [{ nodeId: "build", status: "failed" }] }), {
      any: [{ nodeId: "build", status: "failed" }],
    });
    let condition: unknown = { nodeId: "build", status: "passed" };
    for (let index = 0; index < 9; index++) condition = { not: condition };
    assert.throws(() => parseLoopDagCondition(condition), /too deeply nested/);
  });
});
