// Pure-logic tests for the new CLI helpers. The CLI has no vitest infra and
// vitest is not resolvable from apps/cli, so this is a dependency-free runner
// (run via `tsx`): each case asserts with node:assert; a non-zero exit on the
// first failure is enough signal for `pnpm test`.

import assert from "node:assert/strict";
import { fail, formatError, green, makeColorizer, useColor } from "../colors.js";
import { addMcpServer, removeMcpServer } from "../mcp-config.js";
import { buildJsonResult, isMachineFormat, resolveOutputFormat } from "../output-format.js";
import { composePrompt } from "../stdin-prompt.js";

// Matches a raw ANSI escape introducer (ESC + "["). Detecting these is the
// whole point of the color-gating tests, so the control char is intentional.
const ANSI = new RegExp("\\x1b\\[");

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

// --- composePrompt (stdin precedence) ---------------------------------------
test("composePrompt: inline only", () => {
  assert.equal(composePrompt("fix the bug", undefined), "fix the bug");
});
test("composePrompt: stdin only is the whole prompt", () => {
  assert.equal(composePrompt(undefined, "do this task"), "do this task");
});
test("composePrompt: inline + stdin are fenced together", () => {
  assert.equal(
    composePrompt("explain this", "err line 1\nerr line 2"),
    "explain this\n\n--- piped input ---\nerr line 1\nerr line 2",
  );
});
test("composePrompt: whitespace-only treated as empty", () => {
  assert.equal(composePrompt("   ", "real"), "real");
  assert.equal(composePrompt("real", "  \n "), "real");
});
test("composePrompt: neither → null", () => {
  assert.equal(composePrompt(undefined, undefined), null);
  assert.equal(composePrompt("", ""), null);
});

// --- resolveOutputFormat / aliasing -----------------------------------------
test("resolveOutputFormat: default text", () => {
  assert.equal(resolveOutputFormat({}), "text");
});
test("resolveOutputFormat: --json aliases stream-json", () => {
  assert.equal(resolveOutputFormat({ json: true }), "stream-json");
});
test("resolveOutputFormat: explicit values", () => {
  assert.equal(resolveOutputFormat({ outputFormat: "json" }), "json");
  assert.equal(resolveOutputFormat({ outputFormat: "STREAM-JSON" }), "stream-json");
});
test("resolveOutputFormat: --output-format wins over --json", () => {
  assert.equal(resolveOutputFormat({ outputFormat: "text", json: true }), "text");
});
test("resolveOutputFormat: invalid throws", () => {
  assert.throws(() => resolveOutputFormat({ outputFormat: "yaml" }));
});
test("isMachineFormat", () => {
  assert.equal(isMachineFormat("text"), false);
  assert.equal(isMachineFormat("json"), true);
  assert.equal(isMachineFormat("stream-json"), true);
});
test("buildJsonResult shape", () => {
  const r = buildJsonResult(
    { summary: "s", changedFiles: ["a"], commandsRun: [], verification: "ok", usage: { promptTokens: 1, completionTokens: 2, cacheHitTokens: 0, costUsd: 0.1 } },
    "sess-1",
  );
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.summary, "s");
  assert.deepEqual(r.changedFiles, ["a"]);
});

// --- mcp-config mutation ----------------------------------------------------
test("addMcpServer: adds entry, preserves other keys", () => {
  const doc = { model: "deepseek-chat" } as Record<string, unknown>;
  const next = addMcpServer(doc, "fs", "npx", ["-y", "pkg"]);
  assert.equal(next.model, "deepseek-chat");
  assert.deepEqual(next.mcpServers, { fs: { command: "npx", args: ["-y", "pkg"] } });
  assert.equal((doc as { mcpServers?: unknown }).mcpServers, undefined); // input unchanged
});
test("addMcpServer: no args omits args key", () => {
  const next = addMcpServer({}, "x", "run", []);
  assert.deepEqual(next.mcpServers?.x, { command: "run" });
});
test("addMcpServer: duplicate throws", () => {
  const doc = addMcpServer({}, "fs", "npx", []);
  assert.throws(() => addMcpServer(doc, "fs", "npx", []));
});
test("addMcpServer: empty name/command throws", () => {
  assert.throws(() => addMcpServer({}, "", "npx", []));
  assert.throws(() => addMcpServer({}, "x", "", []));
});
test("removeMcpServer: removes and drops empty map", () => {
  const doc = addMcpServer({ model: "m" }, "fs", "npx", []);
  const next = removeMcpServer(doc, "fs");
  assert.equal(next.mcpServers, undefined);
  assert.equal(next.model, "m");
});
test("removeMcpServer: keeps siblings", () => {
  let doc = addMcpServer({}, "a", "x", []);
  doc = addMcpServer(doc, "b", "y", []);
  const next = removeMcpServer(doc, "a");
  assert.deepEqual(Object.keys(next.mcpServers ?? {}), ["b"]);
});
test("removeMcpServer: missing throws", () => {
  assert.throws(() => removeMcpServer({}, "nope"));
});

// --- useColor predicate ------------------------------------------------------
test("useColor: TTY on + NO_COLOR off + not machine → true", () => {
  assert.equal(useColor({ isTTY: true, noColor: false, machine: false }), true);
});
test("useColor: NO_COLOR set → false even on a TTY", () => {
  assert.equal(useColor({ isTTY: true, noColor: true, machine: false }), false);
});
test("useColor: non-TTY (piped) → false", () => {
  assert.equal(useColor({ isTTY: false, noColor: false, machine: false }), false);
});
test("useColor: machine mode → false even on a TTY with NO_COLOR off", () => {
  assert.equal(useColor({ isTTY: true, noColor: false, machine: true }), false);
});

// --- color helpers no-op when disabled --------------------------------------
test("color helper colors when enabled, plain when disabled", () => {
  assert.match(green("ok", true), ANSI);
  assert.equal(green("ok", false), "ok");
});
test("makeColorizer(false) emits zero escapes for every helper", () => {
  const c = makeColorizer(false);
  for (const s of [c.green("a"), c.red("b"), c.yellow("c"), c.dim("d"), c.italic("e"), c.dimItalic("f")]) {
    assert.doesNotMatch(s, ANSI);
  }
  assert.equal(c.enabled, false);
});
test("makeColorizer(true) wraps in escapes (and resets)", () => {
  const c = makeColorizer(true);
  assert.match(c.green("x"), ANSI);
  assert.match(c.green("x"), /\x1b\[0m$/); // ends with reset
});

// --- machine-format selection forces color off ------------------------------
test("isMachineFormat(json/stream-json) gates color off via useColor", () => {
  // The wiring: machine = isMachineFormat(format); color = useColor({ machine }).
  assert.equal(useColor({ isTTY: true, noColor: false, machine: isMachineFormat("json") }), false);
  assert.equal(useColor({ isTTY: true, noColor: false, machine: isMachineFormat("stream-json") }), false);
  // text on a TTY keeps color
  assert.equal(useColor({ isTTY: true, noColor: false, machine: isMachineFormat("text") }), true);
});

// --- fail / formatError formatting ------------------------------------------
test("formatError: plain message", () => {
  assert.equal(formatError("boom"), "error: boom");
});
test("formatError: with hint adds a → line", () => {
  assert.equal(formatError("boom", "do x"), "error: boom\n  → do x");
});
test("fail: writes error: to STDERR (not stdout) and sets exit code", () => {
  const prevExit = process.exitCode;
  const prevErr = process.stderr.write.bind(process.stderr);
  const prevOut = process.stdout.write.bind(process.stdout);
  let errOut = "";
  let stdoutOut = "";
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    errOut += String(chunk);
    return true;
  };
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdoutOut += String(chunk);
    return true;
  };
  try {
    fail("kaboom", { hint: "try again", code: 3 });
  } finally {
    process.stderr.write = prevErr;
    process.stdout.write = prevOut;
  }
  assert.match(errOut, /error:/);
  assert.match(errOut, /kaboom/);
  assert.match(errOut, /→ try again/);
  assert.equal(stdoutOut, ""); // never corrupts stdout
  assert.equal(process.exitCode, 3);
  process.exitCode = prevExit; // restore so the runner can still exit 0
});

console.log(`${passed} CLI helper tests passed`);
