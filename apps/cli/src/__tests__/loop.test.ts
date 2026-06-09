// Tests for the `seekforge loop` formatting helpers. Matching the other CLI
// tests (helpers/output-style/config), this is a dependency-free runner (run
// via `tsx`): each case asserts with node:assert and exits non-zero on the
// first failure so `pnpm test` fails. No model/core calls — we feed synthetic
// LoopEvent/LoopResult values into the pure formatters.

import assert from "node:assert/strict";
import type { LoopEvent, LoopResult } from "@seekforge/core";
import { formatLoopEvent, formatSummary, outputTail } from "../commands/loop.js";
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

console.log(`${passed} loop tests passed`);
