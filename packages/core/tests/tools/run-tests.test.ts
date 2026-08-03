import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@seekforge/shared";
import { createDefaultDispatcher } from "../../src/tools/index.js";
import { setShellRunnerForTests } from "../../src/tools/builtins/command.js";
import { resolveTestCommand } from "../../src/tools/builtins/tests.js";
import { call, makeCtx, makeWorkspace } from "./helpers.js";

/**
 * run_tests exists to turn a failing suite into data. What matters is that it
 * picks the project's own command, is gated exactly like run_command, and
 * reports which tests failed rather than only that something did.
 */

const dispatcher = createDefaultDispatcher();

afterEach(() => setShellRunnerForTests(null));

/** Stub the shell so no real suite runs; records what it was asked to run. */
function stubShell(result: { exitCode: number; stdout?: string; stderr?: string }): { commands: string[] } {
  const commands: string[] = [];
  setShellRunnerForTests(async (command: string) => {
    commands.push(command);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: 5,
    };
  });
  return { commands };
}

function nodeProject(scripts: Record<string, string>): string {
  const ws = makeWorkspace();
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "p", scripts }));
  return ws;
}

const VITEST_FAILURE = `
 FAIL  tests/math.test.ts > adds two numbers
AssertionError: expected 3 to be 4
 ❯ tests/math.test.ts:12:20

 Test Files  1 failed (1)
      Tests  1 failed | 4 passed (5)
`;

describe("choosing the command", () => {
  it("uses the project's own test script when none is given", () => {
    const ws = nodeProject({ test: "vitest run", build: "tsc" });
    expect(resolveTestCommand(ws)).toContain("test");
  });

  it("says so when a project has no discoverable test command", () => {
    expect(() => resolveTestCommand(makeWorkspace())).toThrowError(/No test command/);
  });

  it("runs exactly what the caller asked for, when they asked", async () => {
    const { commands } = stubShell({ exitCode: 0 });
    const res = await dispatcher.execute(
      call("run_tests", { command: "pnpm vitest run tests/one.test.ts" }),
      makeCtx(nodeProject({ test: "vitest run" })),
    );
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(commands).toEqual(["pnpm vitest run tests/one.test.ts"]);
  });
});

describe("reporting the outcome", () => {
  it("reports a pass without diagnosing anything", async () => {
    stubShell({ exitCode: 0, stdout: "Tests  5 passed (5)" });
    const res = await dispatcher.execute(call("run_tests", {}), makeCtx(nodeProject({ test: "vitest run" })));
    const data = res.data as Record<string, unknown>;
    expect(data.passed).toBe(true);
    expect(data.failedTests).toBeUndefined();
    expect(data.summary).toBeUndefined();
  });

  it("names the failing test and where it failed", async () => {
    stubShell({ exitCode: 1, stdout: VITEST_FAILURE });
    const res = await dispatcher.execute(call("run_tests", {}), makeCtx(nodeProject({ test: "vitest run" })));
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    const data = res.data as {
      passed: boolean;
      framework: string;
      failedTests: string[];
      diagnostics: Array<{ file?: string; line?: number; message: string }>;
      output: string;
    };
    expect(data.passed).toBe(false);
    expect(data.framework).toBe("vitest");
    expect(data.failedTests.join(" ")).toContain("adds two numbers");
    expect(data.diagnostics.some((d) => d.message.includes("expected 3 to be 4"))).toBe(true);
    // The raw output survives, for whatever the parser did not recognize.
    expect(data.output).toContain("Test Files  1 failed");
  });

  it("still returns the output when the runner is one the parser does not know", async () => {
    stubShell({ exitCode: 2, stdout: "our-bespoke-runner: 3 of 9 checks did not pass" });
    const res = await dispatcher.execute(call("run_tests", {}), makeCtx(nodeProject({ test: "make check" })));
    const data = res.data as { passed: boolean; failedTests: string[]; output: string };
    expect(data.passed).toBe(false);
    expect(data.failedTests).toEqual([]);
    expect(data.output).toContain("3 of 9 checks did not pass");
  });
});

describe("it is gated exactly like run_command", () => {
  it("asks for the same approval, showing the command verbatim", async () => {
    stubShell({ exitCode: 0 });
    const requests: PermissionRequest[] = [];
    const res = await dispatcher.execute(
      call("run_tests", { command: "npm run test:integration" }),
      makeCtx(nodeProject({ test: "vitest run" }), {
        policy: { approvalMode: "confirm" },
        confirm: async (req) => {
          requests.push(req);
          return true;
        },
      }),
    );
    expect(res.ok).toBe(true);
    expect(requests[0]?.permission).toBe("execute");
    expect(requests[0]?.command).toBe("npm run test:integration");
  });

  it("refuses a destructive command without ever prompting", async () => {
    const { commands } = stubShell({ exitCode: 0 });
    let prompted = 0;
    const res = await dispatcher.execute(
      call("run_tests", { command: "sudo rm -rf /" }),
      makeCtx(nodeProject({ test: "vitest run" }), {
        policy: { approvalMode: "auto" },
        confirm: async () => {
          prompted++;
          return true;
        },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_dangerous");
    expect(prompted).toBe(0);
    expect(commands).toEqual([]);
  });

  it("is denied by a rule aimed at it, like any other tool", async () => {
    stubShell({ exitCode: 0 });
    const res = await dispatcher.execute(
      call("run_tests", {}),
      makeCtx(nodeProject({ test: "vitest run" }), {
        policy: { approvalMode: "auto", rules: [{ action: "deny", tool: "run_tests" }] },
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("denied_by_rule");
  });
});
