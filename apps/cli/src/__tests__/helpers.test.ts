// Pure-logic tests for the new CLI helpers. The CLI has no vitest infra and
// vitest is not resolvable from apps/cli, so this is a dependency-free runner
// (run via `tsx`): each case asserts with node:assert; a non-zero exit on the
// first failure is enough signal for `pnpm test`.

import assert from "node:assert/strict";
import { addMcpServer, removeMcpServer } from "../mcp-config.js";
import { buildJsonResult, isMachineFormat, resolveOutputFormat } from "../output-format.js";
import { composePrompt } from "../stdin-prompt.js";

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

console.log(`${passed} CLI helper tests passed`);
