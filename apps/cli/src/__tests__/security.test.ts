import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
import { test } from "vitest";
import { Command } from "commander";
import { appendSecurityEvent, newSecurityEventId, type Finding } from "@seekforge/core";
import { registerSecurityCommands } from "../commands/register-security.js";
import {
  securityExportCommand,
  securityListCommand,
  securityShowCommand,
  securityStatusCommand,
} from "../commands/security.js";

function capture(workspace: string, fn: () => void): string {
  const cwd = process.cwd();
  const original = process.stdout.write.bind(process.stdout);
  // vitest intercepts console.log (it does not go through process.stdout.write
  // under the vitest runner), so capture it directly as well.
  const originalLog = console.log;
  let output = "";
  process.chdir(workspace);
  (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
    output += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  console.log = (...args: unknown[]): void => {
    output += `${format(...args)}\n`;
  };
  try {
    fn();
  } finally {
    (process.stdout.write as unknown) = original;
    console.log = originalLog;
    process.chdir(cwd);
  }
  return output;
}

function seed(workspace: string): Finding {
  writeFileSync(join(workspace, "app.ts"), "eval(input);\n");
  const at = new Date().toISOString();
  const finding: Finding = {
    id: "sf-cli-test",
    fingerprint: "b".repeat(64),
    title: "Code injection",
    description: "Input reaches eval.",
    severity: "critical",
    confidence: "high",
    category: "code-injection",
    cwe: "CWE-95",
    recommendation: "Use a parser.",
    evidence: [{ path: "app.ts", lineStart: 1, lineEnd: 1, excerpt: "eval(input);" }],
    source: { scanner: "test", version: "1", ruleId: "eval-input" },
    status: "open",
    verificationStatus: "unverified",
    firstSeenAt: at,
    lastSeenAt: at,
    scanRunId: "scan-test",
  };
  appendSecurityEvent(workspace, {
    version: 1,
    id: newSecurityEventId("finding"),
    at,
    type: "finding.detected",
    finding,
  });
  return finding;
}

test("registers every security subcommand", () => {
  const program = new Command();
  registerSecurityCommands(program);
  const security = program.commands.find((command) => command.name() === "security");
  assert.ok(security);
  assert.deepEqual(
    security.commands.map((command) => command.name()),
    ["scan", "list", "show", "status", "fix", "verify", "threat-model", "export"],
  );
});

test("lists, shows, and transitions a Finding", () => {
  const workspace = mkdtempSync(join(tmpdir(), "seekforge-security-cli-"));
  seed(workspace);
  const listed = capture(workspace, () => securityListCommand());
  assert.match(listed, /sf-cli-test/);
  assert.match(listed, /critical/);
  const shown = capture(workspace, () => securityShowCommand("sf-cli-test"));
  assert.match(shown, /app\.ts:1-1/);
  assert.match(shown, /Use a parser/);
  const status = capture(workspace, () => securityStatusCommand("sf-cli-test", "triaged", { reason: "confirmed" }));
  assert.match(status, /triaged/);
  const json = JSON.parse(
    capture(workspace, () => securityListCommand({ status: "triaged", json: true })),
  ) as Finding[];
  assert.equal(json.length, 1);
  assert.equal(json[0]?.status, "triaged");
  rmSync(workspace, { recursive: true, force: true });
});

test("exports JSON, Markdown, and SARIF evidence and writes mode 0600", () => {
  const workspace = mkdtempSync(join(tmpdir(), "seekforge-security-cli-"));
  seed(workspace);
  const json = JSON.parse(capture(workspace, () => securityExportCommand({ format: "json" }))) as {
    findings: Finding[];
  };
  assert.equal(json.findings[0]?.id, "sf-cli-test");
  assert.match(
    capture(workspace, () => securityExportCommand({ format: "markdown" })),
    /Security Evidence Report/,
  );
  const sarif = JSON.parse(capture(workspace, () => securityExportCommand({ format: "sarif" }))) as { version: string };
  assert.equal(sarif.version, "2.1.0");
  capture(workspace, () => securityExportCommand({ format: "sarif", output: "reports/security.sarif" }));
  const target = join(workspace, "reports", "security.sarif");
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.match(readFileSync(target, "utf8"), /seekforgeFindingId/);
  rmSync(workspace, { recursive: true, force: true });
});
