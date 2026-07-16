// Pure-logic tests for the new CLI helpers, asserted with node:assert.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { fail, formatError, green, makeColorizer, useColor } from "../colors.js";
import { addMcpServer, extractMcpServersDoc, readConfigDoc, removeMcpServer, writeConfigDoc } from "../mcp-config.js";
import type { AgentEvent } from "@seekforge/shared";
import {
  buildResultEnvelope,
  buildUsage,
  createStreamJsonMapper,
  isMachineFormat,
  outcomeFromErrorCode,
  resolveOutputFormat,
} from "../output-format.js";
import { composePrompt } from "../stdin-prompt.js";
import { isCostBudgetExceeded } from "../cost-budget.js";
import { buildToolGatingRules, parseToolList } from "../tool-gating.js";
import { isCacheFresh } from "../version-check.js";
import { parseIndexList, parseNumberedChoice } from "../input-selection.js";

// Matches a raw ANSI escape introducer (ESC + "["). Detecting these is the
// whole point of the color-gating tests, so the control char is intentional.
const ANSI = /\x1b\[/;

test("version cache rejects non-finite timestamps and intervals", () => {
  const entry = { checkedAt: 100, latest: "1.2.3" };
  assert.equal(isCacheFresh(entry, 150, 100), true);
  assert.equal(isCacheFresh({ ...entry, checkedAt: Infinity }, 150, 100), false);
  assert.equal(isCacheFresh(entry, Infinity, 100), false);
  assert.equal(isCacheFresh(entry, 150, Infinity), false);
});

// Timeout raised: this spawns the full CLI through the tsx loader, which can
// take well over vitest's default 5s on a cold cache.
test("memory compact rejects an invalid --prune-unused value before executing", { timeout: 60_000 }, () => {
  const workspace = mkdtempSync(join(tmpdir(), "seekforge-cli-prune-"));
  try {
    const cliDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cli = resolve(cliDir, "src/index.ts");
    const tsxLoader = resolve(cliDir, "node_modules/tsx/dist/loader.mjs");
    const result = spawnSync(
      process.execPath,
      ["--import", tsxLoader, cli, "memory", "compact", "--prune-unused", "12days"],
      { cwd: workspace, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be a non-negative integer/);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("numbered selections consume the complete input", () => {
  assert.equal(parseNumberedChoice("2", 3), 1);
  assert.equal(parseNumberedChoice(" 3 ", 3), 2);
  for (const invalid of ["", "0", "4", "1abc", "1.0", "1 2", "9007199254740992"]) {
    assert.equal(parseNumberedChoice(invalid, 3), null, invalid);
  }
});

test("hunk selections reject malformed and unknown indices", () => {
  assert.deepEqual(parseIndexList("0, 2,2", [0, 1, 2]), [0, 2]);
  for (const invalid of ["", "0,", "1abc", "-1", "3", "1.0", "9007199254740992"]) {
    assert.equal(parseIndexList(invalid, [0, 1, 2]), null, invalid);
  }
});

// --- isCostBudgetExceeded (per-run cost budget) -----------------------------
test("isCostBudgetExceeded: off when no budget set", () => {
  assert.equal(isCostBudgetExceeded(999, undefined), false);
});
test("isCostBudgetExceeded: non-positive budget is treated as off", () => {
  assert.equal(isCostBudgetExceeded(5, 0), false);
  assert.equal(isCostBudgetExceeded(5, -1), false);
});
test("isCostBudgetExceeded: below budget keeps running", () => {
  assert.equal(isCostBudgetExceeded(0.4, 0.5), false);
});
test("isCostBudgetExceeded: at or over budget stops", () => {
  assert.equal(isCostBudgetExceeded(0.5, 0.5), true);
  assert.equal(isCostBudgetExceeded(0.51, 0.5), true);
});

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
test("resolveOutputFormat: stream-json-raw is valid", () => {
  assert.equal(resolveOutputFormat({ outputFormat: "stream-json-raw" }), "stream-json-raw");
});
test("resolveOutputFormat: invalid throws", () => {
  assert.throws(() => resolveOutputFormat({ outputFormat: "yaml" }));
});
test("isMachineFormat", () => {
  assert.equal(isMachineFormat("text"), false);
  assert.equal(isMachineFormat("json"), true);
  assert.equal(isMachineFormat("stream-json"), true);
  assert.equal(isMachineFormat("stream-json-raw"), true);
});

// --- buildResultEnvelope (Claude `--output-format json` shape) ---------------
const sampleReport = {
  summary: "did the thing",
  changedFiles: ["a.ts"],
  commandsRun: ["pnpm test"],
  verification: "ok",
  usage: { promptTokens: 10, completionTokens: 5, cacheHitTokens: 3, costUsd: 0.042 },
};
test("buildResultEnvelope: Claude field names on success", () => {
  const r = buildResultEnvelope({ report: sampleReport, sessionId: "sess-1", numTurns: 3, durationMs: 1234 });
  assert.equal(r.type, "result");
  assert.equal(r.subtype, "success");
  assert.equal(r.is_error, false);
  assert.equal(r.result, "did the thing");
  assert.equal(r.session_id, "sess-1");
  assert.equal(r.num_turns, 3);
  assert.equal(r.duration_ms, 1234);
  assert.equal(r.total_cost_usd, 0.042);
  const usage = r.usage as Record<string, number>;
  assert.equal(usage.input_tokens, 10);
  assert.equal(usage.output_tokens, 5);
  assert.equal(usage.cache_read_input_tokens, 3);
});
test("buildResultEnvelope: SeekForge extras ride along", () => {
  const r = buildResultEnvelope({ report: sampleReport, sessionId: "s", numTurns: 1, durationMs: 1 });
  assert.deepEqual(r.changedFiles, ["a.ts"]);
  assert.deepEqual(r.commandsRun, ["pnpm test"]);
  assert.equal(r.verification, "ok");
});
test("buildResultEnvelope: null session id when absent", () => {
  const r = buildResultEnvelope({ report: sampleReport, sessionId: undefined, numTurns: 0, durationMs: 0 });
  assert.equal(r.session_id, null);
});
test("buildResultEnvelope: max_turns subtype", () => {
  const r = buildResultEnvelope({ sessionId: "s", numTurns: 50, durationMs: 9, outcome: { kind: "max_turns" } });
  assert.equal(r.subtype, "error_max_turns");
  assert.equal(r.is_error, true);
  assert.equal(r.total_cost_usd, 0); // no report → zeroed cost
  assert.deepEqual(r.usage, {});
});
test("buildResultEnvelope: error subtype puts message in result", () => {
  const r = buildResultEnvelope({
    sessionId: "s",
    numTurns: 1,
    durationMs: 9,
    outcome: { kind: "error", message: "boom" },
  });
  assert.equal(r.subtype, "error");
  assert.equal(r.is_error, true);
  assert.equal(r.result, "boom");
});
test("buildUsage maps DeepSeek tokens to Anthropic names", () => {
  const u = buildUsage({ promptTokens: 7, completionTokens: 2, cacheHitTokens: 1, costUsd: 0 });
  assert.equal(u.input_tokens, 7);
  assert.equal(u.output_tokens, 2);
  assert.equal(u.cache_read_input_tokens, 1);
});
test("outcomeFromErrorCode: max_turns_exceeded → max_turns", () => {
  assert.deepEqual(outcomeFromErrorCode("max_turns_exceeded"), { kind: "max_turns" });
});
test("outcomeFromErrorCode: other → error with message", () => {
  assert.deepEqual(outcomeFromErrorCode("agent_error", "nope"), { kind: "error", message: "nope" });
});

// --- createStreamJsonMapper (AgentEvent → Claude stream envelopes) -----------
test("stream mapper: type taxonomy from a synthetic AgentEvent sequence", () => {
  const m = createStreamJsonMapper();
  const events: AgentEvent[] = [
    { type: "session.created", sessionId: "sess-9" },
    { type: "step.started", title: "thinking" }, // dropped (no Claude equivalent)
    { type: "model.message", content: "hello" },
    { type: "tool.started", toolName: "read_file", args: { path: "a.ts" } },
    { type: "tool.completed", toolName: "read_file", result: { ok: true, data: "x" } },
  ];
  const out = events.flatMap((e) => m.map(e));
  const types = out.map((o) => o.type);
  // leading system init (lazy on first id), then assistant text, assistant
  // tool_use, user tool_result. step.started produced nothing.
  assert.deepEqual(types, ["system", "assistant", "assistant", "user"]);
  assert.equal(out[0]!.subtype, "init");
  assert.equal(out[0]!.session_id, "sess-9");
  // every envelope carries the session id
  for (const o of out) assert.equal(o.session_id, "sess-9");
  // turn counting tracks text-producing model messages
  assert.equal(m.turns(), 1);
});
test("stream mapper: tool_result is_error reflects failed tool", () => {
  const m = createStreamJsonMapper();
  m.map({ type: "session.created", sessionId: "s" });
  const out = m.map({
    type: "tool.completed",
    toolName: "run_command",
    result: { ok: false, error: { code: "x", message: "fail" } },
  });
  const content = (out[0]!.message as { content: Array<{ is_error: boolean }> }).content;
  assert.equal(content[0]!.is_error, true);
});
test("stream mapper: result() reuses tracked turn count", () => {
  const m = createStreamJsonMapper();
  m.map({ type: "session.created", sessionId: "s" });
  m.map({ type: "model.message", content: "a" });
  m.map({ type: "model.message", content: "b" });
  const r = m.result({ report: sampleReport, sessionId: "s", numTurns: 0, durationMs: 5 });
  assert.equal(r.type, "result");
  assert.equal(r.num_turns, 2); // falls back to the mapper's count when 0 passed
});

// --- tool gating (--allowedTools / --disallowedTools) -----------------------
test("parseToolList: splits commas and trims", () => {
  assert.deepEqual(parseToolList("read_file, search_text ,, run_command"), ["read_file", "search_text", "run_command"]);
  assert.deepEqual(parseToolList(undefined), []);
});
test("buildToolGatingRules: neither flag → undefined (config passes through)", () => {
  assert.equal(buildToolGatingRules({}), undefined);
});
test("buildToolGatingRules: --disallowedTools → one deny per tool", () => {
  const rules = buildToolGatingRules({ disallowedTools: "run_command,write_file" });
  assert.deepEqual(rules, [
    { action: "deny", tool: "run_command" },
    { action: "deny", tool: "write_file" },
  ]);
});
test("buildToolGatingRules: --allowedTools denies every other known tool", () => {
  const rules = buildToolGatingRules({
    allowedTools: "read_file,search_text",
    knownTools: ["read_file", "search_text", "run_command", "write_file"],
  });
  assert.ok(rules);
  // listed tools get NO rule; the rest are denied
  assert.deepEqual(rules, [
    { action: "deny", tool: "run_command" },
    { action: "deny", tool: "write_file" },
  ]);
});
test("buildToolGatingRules: allow + disallow do not duplicate a denied tool", () => {
  const rules = buildToolGatingRules({
    allowedTools: "read_file",
    disallowedTools: "run_command",
    knownTools: ["read_file", "run_command", "write_file"],
  });
  // run_command denied once (explicit), write_file denied (not in allow-list),
  // read_file allowed (no rule).
  assert.deepEqual(rules, [
    { action: "deny", tool: "run_command" },
    { action: "deny", tool: "write_file" },
  ]);
});
test("buildToolGatingRules: base rules are appended after synthesized", () => {
  const base = [{ action: "allow" as const, tool: "web_fetch", match: "https://docs" }];
  const rules = buildToolGatingRules({ disallowedTools: "run_command", base });
  assert.deepEqual(rules, [{ action: "deny", tool: "run_command" }, ...base]);
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
test("readConfigDoc: non-object JSON falls back to empty doc", () => {
  const dir = mkdtempSync(join(tmpdir(), "seekforge-mcp-config-"));
  try {
    for (const [name, content] of [
      ["null.json", "null"],
      ["array.json", "[]"],
      ["string.json", '"x"'],
    ] as const) {
      const file = join(dir, name);
      writeFileSync(file, content);
      assert.deepEqual(readConfigDoc(file), {});
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("writeConfigDoc refuses symlinked project config targets", () => {
  const project = mkdtempSync(join(tmpdir(), "seekforge-mcp-project-"));
  const externalDir = mkdtempSync(join(tmpdir(), "seekforge-mcp-external-"));
  try {
    const stateDir = join(project, ".seekforge");
    const external = join(externalDir, "config.json");
    mkdirSync(stateDir);
    writeFileSync(external, '{"keep":true}\n');
    symlinkSync(external, join(stateDir, "config.json"));
    assert.throws(() => writeConfigDoc(join(stateDir, "config.json"), { mcpServers: {} }), /regular file|symlink/);
    assert.equal(readFileSync(external, "utf8"), '{"keep":true}\n');
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(externalDir, { recursive: true, force: true });
  }
});
test("extractMcpServersDoc: accepts wrapped and bare object maps only", () => {
  assert.deepEqual(extractMcpServersDoc({ mcpServers: { fs: { command: "npx" } } }), {
    fs: { command: "npx" },
  });
  assert.deepEqual(extractMcpServersDoc({ fs: { command: "npx" } }), { fs: { command: "npx" } });
  for (const value of [null, [], "x", { mcpServers: null }, { mcpServers: [] }, { mcpServers: "x" }]) {
    assert.equal(extractMcpServersDoc(value), null);
  }
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
