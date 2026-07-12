// Tests for the `seekforge loop` formatting helpers. Matching the other CLI
// tests (helpers/output-style/config), this is a dependency-free runner (run
// via `tsx`): each case asserts with node:assert and exits non-zero on the
// first failure so `pnpm test` fails. No model/core calls — we feed synthetic
// LoopEvent/LoopResult values into the pure formatters.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoopEvent, LoopResult } from "@seekforge/core";
import {
  coreResumeAutoLoop,
  formatLoopEvent,
  formatLoopState,
  formatSummary,
  outputTail,
  resumeExtensionOptions,
} from "../commands/loop.js";
import { formatLoopWorktree, isRetainedLoopWorktree } from "../loop-worktree.js";
import { setLocale } from "../i18n.js";

setLocale("en"); // deterministic strings

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  }
}

// --- outputTail -------------------------------------------------------------
test("outputTail returns the last N non-trailing-blank lines", () => {
  const out = "a\nb\nc\nd\ne\nf\ng\n\n\n";
  assert.equal(outputTail(out, 3), "e\nf\ng");
});
test("outputTail keeps short output verbatim", () => {
  assert.equal(outputTail("only one line"), "only one line");
});
test("outputTail on empty string is empty", () => {
  assert.equal(outputTail(""), "");
});

// --- formatLoopEvent --------------------------------------------------------
test("iteration.start renders the iteration number", () => {
  const e: LoopEvent = { type: "iteration.start", iteration: 2 };
  assert.match(formatLoopEvent(e), /2/);
});
test("run.completed shows iteration and 4-decimal cost", () => {
  const e: LoopEvent = { type: "run.completed", iteration: 1, costUsd: 0.123456 };
  const line = formatLoopEvent(e);
  assert.match(line, /1/);
  assert.match(line, /0\.1235/); // toFixed(4) rounds
});
test("verify passed line says PASSED and has no exit code", () => {
  const e: LoopEvent = { type: "verify", iteration: 3, code: 0, passed: true, output: "" };
  const line = formatLoopEvent(e);
  assert.match(line, /PASSED/);
  assert.doesNotMatch(line, /exit/);
});
test("verify failed line shows exit code and the output tail", () => {
  const e: LoopEvent = {
    type: "verify",
    iteration: 4,
    code: 2,
    passed: false,
    output: "line1\nline2\nFAIL: boom",
  };
  const line = formatLoopEvent(e);
  assert.match(line, /FAILED/);
  assert.match(line, /exit 2/);
  assert.match(line, /FAIL: boom/); // tail appended
});
test("verify with empty output emits a single line (no trailing newline)", () => {
  const e: LoopEvent = { type: "verify", iteration: 1, code: 0, passed: true, output: "   \n  " };
  const line = formatLoopEvent(e);
  assert.equal(line.includes("\n"), false);
});

// --- formatSummary / loop.done ----------------------------------------------
const result: LoopResult = {
  status: "passed",
  iterations: 3,
  costUsd: 0.5,
  sessionId: "sess_abc123",
  finalVerify: { code: 0, output: "ok" },
};

test("formatSummary includes status, iterations, cost, session id and hints", () => {
  const s = formatSummary(result);
  assert.match(s, /passed/);
  assert.match(s, /3/);
  assert.match(s, /0\.5000/);
  assert.match(s, /sess_abc123/);
  assert.match(s, /seekforge resume sess_abc123/);
  assert.match(s, /seekforge rewind sess_abc123/);
});
test("loop.done event delegates to formatSummary", () => {
  const e: LoopEvent = { type: "loop.done", result };
  assert.equal(formatLoopEvent(e), formatSummary(result));
});
test("formatSummary reflects a non-passed status", () => {
  const s = formatSummary({ ...result, status: "budget" });
  assert.match(s, /budget/);
});
test("formatSummary omits session recovery commands when no session was created", () => {
  const s = formatSummary({ ...result, iterations: 0, costUsd: 0, sessionId: "" });
  assert.match(s, /passed/);
  assert.doesNotMatch(s, /session:/);
  assert.doesNotMatch(s, /seekforge resume/);
  assert.doesNotMatch(s, /seekforge rewind/);
});
test("formatSummary exposes the persisted loop resume id", () => {
  const s = formatSummary({ ...result, loopId: "loop-abc" });
  assert.match(s, /seekforge loop-resume loop-abc/);
});

test("formatLoopWorktree exposes the retained path and branch", () => {
  const text = formatLoopWorktree({ path: "/repo/.seekforge/worktrees/loop-fix", branch: "seekforge/loop-fix" });
  assert.match(text, /retained for inspection/);
  assert.match(text, /\/repo\/\.seekforge\/worktrees\/loop-fix/);
  assert.match(text, /seekforge\/loop-fix/);
});

test("loop resume adapter exposes core support or fails clearly", () => {
  try {
    assert.equal(typeof coreResumeAutoLoop(), "function");
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), /persisted loop resume state/);
  }
});

test("loop resume extensions map to core options without adding absent limits", () => {
  assert.deepEqual(resumeExtensionOptions({ addIters: 3, addBudget: 1.25 }), {
    additionalIterations: 3,
    additionalCostBudgetUsd: 1.25,
  });
  assert.deepEqual(resumeExtensionOptions({}), {});
});

test("formatLoopState includes management-relevant fields", () => {
  const text = formatLoopState({
    loopId: "loop-abc",
    task: "fix tests",
    workspace: "/repo",
    verifyCommand: "pnpm test",
    maxIterations: 8,
    costBudgetUsd: 2,
    iterations: 3,
    costUsd: 0.25,
    sessionId: "session-1",
    lastVerify: null,
    status: "exhausted",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.match(text, /loop-abc/);
  assert.match(text, /3\/8/);
  assert.match(text, /\$0\.2500 \/ \$2\.0000/);
  assert.match(text, /pnpm test/);
});

test("cleanup safety accepts only seekforge branches inside retained root", () => {
  assert.equal(isRetainedLoopWorktree("/repo", {
    path: "/repo/.seekforge/worktrees/loop-fix",
    branch: "seekforge/loop-fix",
  }), true);
  assert.equal(isRetainedLoopWorktree("/repo", { path: "/repo", branch: "main" }), false);
  assert.equal(isRetainedLoopWorktree("/repo", {
    path: "/repo/.seekforge/worktrees/../outside",
    branch: "seekforge/loop-outside",
  }), false);
  assert.equal(isRetainedLoopWorktree("/repo", {
    path: "/repo/.seekforge/worktrees/loop-fix",
    branch: "feature/fix",
  }), false);
});

test("CLI numeric parsers reject trailing junk and non-finite values globally", () => {
  const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const cli = resolve(cliDir, "src/index.ts");
  for (const args of [
    ["run", "task", "--max-turns", "2x"],
    ["run", "task", "--max-cost", "1.5usd"],
    ["loop", "task", "--verify", "true", "--max-iters", "3.0"],
    ["loop-resume", "loop-abc", "--add-budget", "1e999"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      cwd: cliDir,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, args.join(" "));
    assert.match(`${result.stdout}${result.stderr}`, /positive (?:integer|number)/);
  }
});

console.log(`${passed} loop tests passed`);
