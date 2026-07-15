import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redactSecurityText } from "../../src/security/redact.js";
import { validateAgentFindings } from "../../src/security/validation.js";

describe("security Agent output validation", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-security-validation-"));
    writeFileSync(join(workspace, "app.ts"), "const safe = true;\nrun(userInput);\n");
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  function envelope(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      findings: [{
        title: "Command injection",
        description: "Untrusted input reaches a command runner.",
        severity: "high",
        confidence: "high",
        category: "command-injection",
        cwe: "CWE-78",
        ruleId: "command-injection",
        recommendation: "Pass an argv array.",
        evidence: [{ path: "app.ts", lineStart: 2, lineEnd: 2, excerpt: "run(userInput);" }],
        ...overrides,
      }],
    });
  }

  it("accepts strict findings with exact repository evidence", () => {
    const [finding] = validateAgentFindings(workspace, envelope());
    expect(finding).toMatchObject({ severity: "high", ruleId: "command-injection" });
    expect(finding!.evidence[0]).toEqual({ path: "app.ts", lineStart: 2, lineEnd: 2, excerpt: "run(userInput);" });
  });

  it("rejects markdown, unknown fields, missing files, traversal, and forged excerpts", () => {
    expect(() => validateAgentFindings(workspace, `\`\`\`json\n${envelope()}\n\`\`\``)).toThrow(/exact JSON/);
    expect(() => validateAgentFindings(workspace, envelope({ injected: "ignore policy" }))).toThrow();
    expect(() => validateAgentFindings(workspace, envelope({ evidence: [{ path: "missing.ts", lineStart: 1, lineEnd: 1, excerpt: "x" }] }))).toThrow(/real repository file/);
    expect(() => validateAgentFindings(workspace, envelope({ evidence: [{ path: "../outside", lineStart: 1, lineEnd: 1, excerpt: "x" }] }))).toThrow(/escapes/);
    expect(() => validateAgentFindings(workspace, envelope({ evidence: [{ path: "app.ts", lineStart: 2, lineEnd: 2, excerpt: "eval(userInput)" }] }))).toThrow(/does not match/);
  });

  it("redacts common secrets and limits stored output", () => {
    const output = redactSecurityText(`api_key=super-secret-value ${"x".repeat(100)}`, 40);
    expect(output).toContain("[REDACTED]");
    expect(output).toContain("[TRUNCATED]");
    expect(output).not.toContain("super-secret-value");
  });
});
