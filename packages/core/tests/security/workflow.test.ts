import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@seekforge/shared";
import type { AgentCore } from "../../src/agent/index.js";
import { completeFixAttempt, runSecurityCommand, startFixAttempt } from "../../src/security/fix.js";
import { renderSecurityExport, writeSecurityExport } from "../../src/security/report.js";
import { isSameFindingFamily, scanRepository } from "../../src/security/scanner.js";
import { buildSecurityState, getFinding } from "../../src/security/store.js";
import { generateThreatModel } from "../../src/security/threat-model.js";

function fakeAgent(message: string): AgentCore {
  return {
    async *runTask(): AsyncIterable<AgentEvent> {
      yield { type: "session.created", sessionId: "session-test" };
      yield { type: "model.message", content: message };
      yield {
        type: "session.completed",
        report: {
          summary: "done",
          changedFiles: [],
          commandsRun: [],
          verification: "not run",
          usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, costUsd: 0 },
        },
      };
    },
  };
}

describe("security scan, threat model, fix verification, and export", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "seekforge-security-workflow-"));
    writeFileSync(join(workspace, "app.ts"), "export function run(input: string) {\n  eval(input);\n}\n");
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const scanJson = JSON.stringify({
    findings: [
      {
        title: "Code injection",
        description: "Input reaches eval.",
        severity: "critical",
        confidence: "high",
        category: "code-injection",
        cwe: "CWE-95",
        ruleId: "ts-eval-input",
        recommendation: "Use a parser.",
        evidence: [{ path: "app.ts", lineStart: 2, lineEnd: 2, excerpt: "eval(input);" }],
      },
    ],
  });

  it("persists validated Agent findings and records rejected scans as failed", async () => {
    const result = await scanRepository({ workspace, agent: fakeAgent(scanJson) });
    expect(result.findings).toHaveLength(1);
    expect(getFinding(workspace, result.findings[0]!.id)?.status).toBe("open");

    await expect(
      scanRepository({
        workspace,
        agent: fakeAgent(
          JSON.stringify({
            findings: [
              {
                title: "Forged",
                description: "No evidence.",
                severity: "high",
                confidence: "high",
                category: "forged",
                ruleId: "forged",
                recommendation: "none",
                evidence: [{ path: "missing.ts", lineStart: 1, lineEnd: 1, excerpt: "x" }],
              },
            ],
          }),
        ),
      }),
    ).rejects.toThrow(/real repository file/);
    expect([...buildSecurityState(workspace).scans.values()].some((scan) => scan.status === "failed")).toBe(true);
  });

  it("keeps a stable finding id when only the scanner wording changes", async () => {
    const first = await scanRepository({ workspace, agent: fakeAgent(scanJson) });
    const renamed = JSON.parse(scanJson) as { findings: Array<{ title: string; description: string }> };
    renamed.findings[0]!.title = "Untrusted input reaches dynamic evaluation";
    renamed.findings[0]!.description = "A caller-controlled value reaches eval.";
    const second = await scanRepository({ workspace, agent: fakeAgent(JSON.stringify(renamed)) });
    expect(second.findings[0]!.id).toBe(first.findings[0]!.id);
    expect(buildSecurityState(workspace).findings).toHaveLength(1);
  });

  it("keeps a stable finding id when unchanged evidence moves to another line", async () => {
    const first = await scanRepository({ workspace, agent: fakeAgent(scanJson) });
    writeFileSync(join(workspace, "app.ts"), "// header\nexport function run(input: string) {\n  eval(input);\n}\n");
    const moved = JSON.parse(scanJson) as {
      findings: Array<{ evidence: Array<{ lineStart: number; lineEnd: number }> }>;
    };
    moved.findings[0]!.evidence[0]!.lineStart = 3;
    moved.findings[0]!.evidence[0]!.lineEnd = 3;
    const second = await scanRepository({ workspace, agent: fakeAgent(JSON.stringify(moved)) });
    expect(second.findings[0]!.id).toBe(first.findings[0]!.id);
    expect(buildSecurityState(workspace).findings).toHaveLength(1);
  });

  it("matches a finding family conservatively when evidence content changes", async () => {
    const first = (await scanRepository({ workspace, agent: fakeAgent(scanJson) })).findings[0]!;
    const changed = {
      ...first,
      id: "sf-new-fingerprint",
      fingerprint: "c".repeat(64),
      evidence: [{ ...first.evidence[0]!, excerpt: "globalThis.eval(input);" }],
    };
    expect(isSameFindingFamily(first, changed)).toBe(true);
    expect(
      isSameFindingFamily(first, {
        ...changed,
        source: { ...changed.source, ruleId: "different-rule" },
      }),
    ).toBe(false);
  });

  it("generates an evidence-backed threat model", async () => {
    const item = {
      name: "Input",
      description: "Public input",
      evidence: [{ path: "app.ts", lineStart: 1, lineEnd: 2 }],
    };
    const model = await generateThreatModel({
      workspace,
      agent: fakeAgent(
        JSON.stringify({
          summary: "Input crosses into code execution.",
          assets: [item],
          entryPoints: [item],
          trustBoundaries: [item],
          dataFlows: [item],
          threats: [
            {
              title: "Injection",
              scenario: "Attacker controls input.",
              affectedAssets: ["Input"],
              entryPoints: ["run"],
              trustBoundaries: ["caller to eval"],
              mitigations: ["remove eval"],
              severity: "critical",
              evidence: [{ path: "app.ts", lineStart: 1, lineEnd: 2 }],
            },
          ],
        }),
      ),
    });
    expect(model.threats[0]).toMatchObject({ severity: "critical", title: "Injection" });
    expect(buildSecurityState(workspace).threatModels.has(model.id)).toBe(true);
    expect(renderSecurityExport(workspace, "markdown")).toContain("Attacker controls input");
  });

  it("rejects an empty threat-model shell", async () => {
    await expect(
      generateThreatModel({
        workspace,
        agent: fakeAgent(
          JSON.stringify({
            summary: "Nothing inspected.",
            assets: [],
            entryPoints: [],
            trustBoundaries: [],
            dataFlows: [],
            threats: [],
          }),
        ),
      }),
    ).rejects.toThrow();
  });

  it("records checks, resolves only after a clean rescan, and exports SARIF privately", async () => {
    const initial = await scanRepository({ workspace, agent: fakeAgent(scanJson) });
    const finding = initial.findings[0]!;
    const fix = startFixAttempt(workspace, finding.id);
    const command = await runSecurityCommand({ workspace, kind: "verify", command: "printf ok" });
    expect(command).toMatchObject({ exitCode: 0, stdout: "ok", timedOut: false });

    const clean = await scanRepository({ workspace, agent: fakeAgent('{"findings":[]}') });
    const completed = completeFixAttempt({
      workspace,
      fix,
      agentCompleted: true,
      commands: [command],
      verificationScan: clean.scan,
      findingStillPresent: false,
      introducedBlockingFindings: [],
    });
    expect(completed.status).toBe("verified");
    expect(getFinding(workspace, finding.id)).toMatchObject({ status: "resolved", verificationStatus: "verified" });
    const markdown = renderSecurityExport(workspace, "markdown");
    expect(markdown).toContain("## Fix Attempts");
    expect(markdown).toContain("printf ok");

    const sarif = JSON.parse(renderSecurityExport(workspace, "sarif")) as {
      version: string;
      runs: Array<{ results: unknown[] }>;
    };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0]!.results).toHaveLength(1);
    const target = writeSecurityExport(workspace, "reports/security.sarif", "sarif");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toContain('"version": "2.1.0"');
  });

  it("escapes model-controlled Markdown structure and HTML", async () => {
    const injected = JSON.parse(scanJson) as { findings: Array<{ title: string; description: string }> };
    injected.findings[0]!.title = "Finding\n## Forged section";
    injected.findings[0]!.description = "<script>alert(1)</script>";
    await scanRepository({ workspace, agent: fakeAgent(JSON.stringify(injected)) });
    const markdown = renderSecurityExport(workspace, "markdown");
    expect(markdown).not.toContain("\n## Forged section");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("&lt;script&gt;");
  });

  it("fails closed when no project verification command is configured", async () => {
    const initial = await scanRepository({ workspace, agent: fakeAgent(scanJson) });
    const finding = initial.findings[0]!;
    const fix = startFixAttempt(workspace, finding.id);
    const clean = await scanRepository({ workspace, agent: fakeAgent('{"findings":[]}') });
    const completed = completeFixAttempt({
      workspace,
      fix,
      agentCompleted: true,
      commands: [],
      verificationScan: clean.scan,
      findingStillPresent: false,
      introducedBlockingFindings: [],
    });
    expect(completed).toMatchObject({
      status: "verification_failed",
      notes: "no project verification command is configured",
    });
    expect(getFinding(workspace, finding.id)).toMatchObject({ status: "open", verificationStatus: "failed" });
  });
});
