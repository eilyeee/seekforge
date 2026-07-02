// Tests for the `seekforge audit` command. Same tsx runner + node:assert
// pattern as the other CLI tests (vitest is not resolvable from apps/cli).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCheckpoint, createSessionTrace, writeSessionMeta } from "@seekforge/core";
import { auditCommand } from "../commands/audit.js";

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

/** Run `fn` with cwd set to `dir` and process.stdout.write captured. */
function capture(dir: string, fn: () => void): string {
  const cwd = process.cwd();
  const orig = process.stdout.write.bind(process.stdout);
  let out = "";
  process.chdir(dir);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    out += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    fn();
  } finally {
    (process.stdout.write as unknown) = orig;
    process.chdir(cwd);
  }
  return out;
}

function seed(ws: string, sid: string): void {
  writeSessionMeta(ws, {
    id: sid,
    task: "add a feature",
    mode: "edit",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    usage: { promptTokens: 100, completionTokens: 20, cacheHitTokens: 50, costUsd: 0.001 },
  });
  const trace = createSessionTrace(ws, sid);
  trace.message({ role: "system", content: "system prompt" });
  trace.message({ role: "user", content: "add a feature" });
  trace.message({
    role: "assistant",
    content: "Editing.",
    toolCalls: [{ id: "c1", name: "write_file", argumentsJson: '{"path":"new.txt"}' }],
  });
  trace.message({ role: "tool", content: '{"ok":true,"data":"written"}', toolCallId: "c1" });
  appendCheckpoint(ws, sid, { ts: "t0", path: "new.txt", before: null, turn: 0 });
}

test("prints a markdown report to stdout by default", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  seed(ws, "s1");
  const out = capture(ws, () => auditCommand("s1"));
  assert.match(out, /# Session Audit — add a feature/);
  assert.match(out, /## Files changed/);
  assert.match(out, /`new\.txt` \(created\)/);
  assert.match(out, /✓ write_file\(/);
  rmSync(ws, { recursive: true, force: true });
});

test("--json emits the raw SessionAudit", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  seed(ws, "s1");
  const out = capture(ws, () => auditCommand("s1", { json: true }));
  const parsed = JSON.parse(out) as { meta: { id: string }; totals: { toolCalls: number } };
  assert.equal(parsed.meta.id, "s1");
  assert.equal(parsed.totals.toolCalls, 1);
  rmSync(ws, { recursive: true, force: true });
});

test("-o writes the report to a file", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  seed(ws, "s1");
  const target = join(ws, "report.md");
  capture(ws, () => auditCommand("s1", { output: target }));
  assert.match(readFileSync(target, "utf8"), /# Session Audit/);
  rmSync(ws, { recursive: true, force: true });
});

test("-o creates a missing parent directory", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  seed(ws, "s1");
  const target = join(ws, "nested", "deep", "report.md");
  capture(ws, () => auditCommand("s1", { output: target }));
  assert.match(readFileSync(target, "utf8"), /# Session Audit/);
  rmSync(ws, { recursive: true, force: true });
});

test("-o fails cleanly (non-zero exit) when the target cannot be written", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  seed(ws, "s1");
  // A regular file sits where the parent directory would need to be, so the
  // mkdirSync guard throws (EEXIST) — the command must fail cleanly, not throw.
  const blocker = join(ws, "blocker");
  writeFileSync(blocker, "not a dir");
  const target = join(blocker, "report.md");
  process.exitCode = 0;
  assert.doesNotThrow(() => capture(ws, () => auditCommand("s1", { output: target })));
  assert.notEqual(process.exitCode, 0);
  process.exitCode = 0; // reset so this test file exits clean
  rmSync(ws, { recursive: true, force: true });
});

test("unknown session id fails with a non-zero exit code", () => {
  const ws = mkdtempSync(join(tmpdir(), "sf-audit-cli-"));
  process.exitCode = 0;
  capture(ws, () => auditCommand("nope"));
  assert.notEqual(process.exitCode, 0);
  process.exitCode = 0; // reset so this test file exits clean
  rmSync(ws, { recursive: true, force: true });
});

console.log(`${passed} audit tests passed`);
