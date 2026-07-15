import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { resolveForWrite } from "../tools/sandbox.js";
import { buildSecurityState } from "./store.js";
import type { Finding, FixAttempt, SecurityEvidencePackage, ThreatModel } from "./types.js";

export type SecurityExportFormat = "json" | "markdown" | "sarif";

function markdownText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}[\]()#+.!|\-])/g, "\\$1");
}

function indentedCode(value: string): string {
  return value.split("\n").map((line) => `    ${line}`).join("\n");
}

export function buildSecurityEvidencePackage(workspace: string): SecurityEvidencePackage {
  const state = buildSecurityState(workspace);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repository: basename(workspace),
    findings: [...state.findings.values()].sort((a, b) => a.id.localeCompare(b.id)),
    scans: [...state.scans.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    fixes: [...state.fixes.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    threatModels: [...state.threatModels.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    events: state.events,
    disclaimer: "This export is an evidence package, not a certification or guarantee of compliance.",
  };
}

function findingMarkdown(finding: Finding): string {
  const evidence = finding.evidence
    .map((item) => `- \`${item.path.replace(/`/g, "\\`")}:${item.lineStart}-${item.lineEnd}\`\n\n${indentedCode(item.excerpt)}`)
    .join("\n");
  return [
    `### ${markdownText(finding.id)}: ${markdownText(finding.title)}`,
    `- Severity: ${markdownText(finding.severity)}`,
    `- Status: ${markdownText(finding.status)}`,
    `- Verification: ${markdownText(finding.verificationStatus)}`,
    `- Source: ${markdownText(finding.source.scanner)}@${markdownText(finding.source.version)} / ${markdownText(finding.source.ruleId)}`,
    "",
    markdownText(finding.description),
    "",
    "Evidence:",
    evidence,
    "",
    `Recommendation: ${markdownText(finding.recommendation)}`,
  ].join("\n");
}

function fixMarkdown(fix: FixAttempt): string {
  const commands = fix.commands.length === 0
    ? "- No project checks recorded."
    : fix.commands.map((command) => [
      `- ${markdownText(command.kind)}: \`${command.command.replace(/`/g, "\\`")}\``,
      `  - Exit: ${command.exitCode}; timeout: ${command.timedOut}; duration: ${command.durationMs} ms`,
      ...(command.stdout ? ["", indentedCode(command.stdout)] : []),
      ...(command.stderr ? ["", indentedCode(command.stderr)] : []),
    ].join("\n")).join("\n");
  return [
    `### ${markdownText(fix.id)}: ${markdownText(fix.findingId)}`,
    `- Status: ${markdownText(fix.status)}`,
    `- Started: ${fix.startedAt}`,
    `- Completed: ${fix.completedAt ?? "in progress"}`,
    `- Notes: ${markdownText(fix.notes ?? "none")}`,
    "",
    commands,
  ].join("\n");
}

function threatModelMarkdown(model: ThreatModel): string {
  const names = (items: ThreatModel["assets"]): string => items.map((item) => markdownText(item.name)).join(", ");
  const threats = model.threats.map((threat) => [
    `#### ${markdownText(threat.id)}: ${markdownText(threat.title)}`,
    `- Severity: ${markdownText(threat.severity)}`,
    `- Affected assets: ${threat.affectedAssets.map(markdownText).join(", ")}`,
    `- Entry points: ${threat.entryPoints.map(markdownText).join(", ")}`,
    `- Trust boundaries: ${threat.trustBoundaries.map(markdownText).join(", ")}`,
    "",
    markdownText(threat.scenario),
    "",
    "Evidence:",
    ...threat.evidence.map((evidence) => `- \`${evidence.path.replace(/`/g, "\\`")}:${evidence.lineStart}-${evidence.lineEnd}\``),
    "",
    "Mitigations:",
    ...(threat.mitigations.length > 0 ? threat.mitigations.map((value) => `- ${markdownText(value)}`) : ["- None recorded."]),
  ].join("\n")).join("\n\n");
  return [
    `### ${markdownText(model.id)}`,
    `- Created: ${model.createdAt}`,
    `- Assets: ${names(model.assets)}`,
    `- Entry points: ${names(model.entryPoints)}`,
    `- Trust boundaries: ${names(model.trustBoundaries)}`,
    "",
    markdownText(model.summary),
    "",
    threats,
  ].join("\n");
}

export function renderSecurityMarkdown(pkg: SecurityEvidencePackage): string {
  const open = pkg.findings.filter((finding) => !["resolved", "dismissed", "accepted_risk"].includes(finding.status));
  const sections = pkg.findings.map(findingMarkdown).join("\n\n");
  const fixes = pkg.fixes.map(fixMarkdown).join("\n\n");
  const threatModels = pkg.threatModels.map(threatModelMarkdown).join("\n\n");
  return [
    "# SeekForge Security Evidence Report",
    "",
    `- Repository: ${markdownText(pkg.repository)}`,
    `- Generated: ${pkg.generatedAt}`,
    `- Findings: ${pkg.findings.length} total, ${open.length} active`,
    `- Scans: ${pkg.scans.length}`,
    `- Fix attempts: ${pkg.fixes.length}`,
    `- Threat models: ${pkg.threatModels.length}`,
    "",
    `> ${markdownText(pkg.disclaimer)}`,
    "",
    "## Findings",
    "",
    sections || "No findings recorded.",
    "",
    "## Fix Attempts",
    "",
    fixes || "No fix attempts recorded.",
    "",
    "## Threat Models",
    "",
    threatModels || "No threat models recorded.",
    "",
  ].join("\n");
}

export function renderSecuritySarif(pkg: SecurityEvidencePackage): string {
  const rules = [...new Map(pkg.findings.map((finding) => [finding.source.ruleId, finding])).values()].map((finding) => ({
    id: finding.source.ruleId,
    name: finding.category.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128) || "security_finding",
    shortDescription: { text: finding.title },
    fullDescription: { text: finding.description },
    help: { text: finding.recommendation },
    defaultConfiguration: { level: sarifLevel(finding.severity) },
    properties: { tags: [finding.category, ...(finding.cwe ? [finding.cwe] : [])] },
  }));
  const results = pkg.findings.map((finding) => ({
    ruleId: finding.source.ruleId,
    level: sarifLevel(finding.severity),
    message: { text: `${finding.title}: ${finding.description}` },
    locations: finding.evidence.map((evidence) => ({
      physicalLocation: {
        artifactLocation: { uri: evidence.path, uriBaseId: "%SRCROOT%" },
        region: { startLine: evidence.lineStart, endLine: evidence.lineEnd, snippet: { text: evidence.excerpt } },
      },
    })),
    partialFingerprints: { seekforgeFindingId: finding.id, seekforgeFingerprint: finding.fingerprint },
    properties: {
      status: finding.status,
      verificationStatus: finding.verificationStatus,
      confidence: finding.confidence,
      scanRunId: finding.scanRunId,
    },
  }));
  return `${JSON.stringify({
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "SeekForge Security",
          informationUri: "https://github.com/eilyeee/seekforge",
          semanticVersion: "1.0.0",
          rules,
        },
      },
      originalUriBaseIds: { "%SRCROOT%": { uri: "./" } },
      automationDetails: { id: `seekforge-security/${pkg.repository}` },
      results,
      properties: { generatedAt: pkg.generatedAt, disclaimer: pkg.disclaimer },
    }],
  }, null, 2)}\n`;
}

function sarifLevel(severity: Finding["severity"]): "error" | "warning" | "note" | "none" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  if (severity === "low") return "note";
  return "none";
}

export function renderSecurityExport(workspace: string, format: SecurityExportFormat): string {
  const pkg = buildSecurityEvidencePackage(workspace);
  if (format === "json") return `${JSON.stringify(pkg, null, 2)}\n`;
  if (format === "markdown") return renderSecurityMarkdown(pkg);
  if (format === "sarif") return renderSecuritySarif(pkg);
  throw new Error(`unknown security export format: ${String(format)}`);
}

export function writeSecurityExport(
  workspace: string,
  outputPath: string,
  format: SecurityExportFormat,
): string {
  const target = resolveForWrite(workspace, outputPath);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, renderSecurityExport(workspace, format), { mode: 0o600 });
  chmodSync(target, 0o600);
  return target;
}
