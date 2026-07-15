import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { z } from "zod";
import { resolveForRead } from "../tools/sandbox.js";
import { FINDING_SEVERITIES, type FindingEvidence, type FindingSeverity } from "./types.js";
import { sanitizeSecurityText } from "./redact.js";

const MAX_FINDINGS = 100;
const MAX_EVIDENCE = 5;

const evidenceSchema = z.object({
  path: z.string().min(1).max(1_000),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  excerpt: z.string().min(1).max(20_000),
}).strict();

const rawFindingSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(8_000),
  severity: z.enum(FINDING_SEVERITIES),
  confidence: z.enum(["low", "medium", "high"]),
  category: z.string().min(1).max(200),
  cwe: z.string().max(64).optional(),
  ruleId: z.string().min(1).max(200),
  recommendation: z.string().min(1).max(8_000),
  evidence: z.array(evidenceSchema).min(1).max(MAX_EVIDENCE),
}).strict();

export const agentScanEnvelopeSchema = z.object({
  findings: z.array(rawFindingSchema).max(MAX_FINDINGS),
}).strict();

export type ValidatedAgentFinding = {
  title: string;
  description: string;
  severity: FindingSeverity;
  confidence: "low" | "medium" | "high";
  category: string;
  cwe?: string;
  ruleId: string;
  recommendation: string;
  evidence: FindingEvidence[];
};

export function parseExactJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new Error("agent output must be one exact JSON object without markdown fences or commentary");
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("agent output must be a JSON object");
  }
  return parsed;
}

function validateRelativeEvidencePath(workspace: string, rawPath: string): string {
  if (isAbsolute(rawPath) || rawPath.includes("\0")) throw new Error(`evidence path must be relative: ${rawPath}`);
  const normalized = rawPath.replaceAll("\\", "/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`evidence path escapes the repository: ${rawPath}`);
  }
  const resolved = resolveForRead(workspace, normalized);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`evidence path is not a real repository file: ${rawPath}`);
  }
  const rel = relative(realpathSync(workspace), resolved).split(sep).join("/");
  if (!rel || rel.startsWith("../")) throw new Error(`invalid evidence path: ${rawPath}`);
  return rel;
}

export function validateEvidence(workspace: string, raw: z.infer<typeof evidenceSchema>): FindingEvidence {
  const path = validateRelativeEvidencePath(workspace, raw.path);
  const resolved = resolveForRead(workspace, path);
  const content = readFileSync(resolved, "utf8").replace(/\r\n/g, "\n");
  const lines = content.split("\n");
  if (raw.lineEnd < raw.lineStart || raw.lineEnd > lines.length) {
    throw new Error(`invalid evidence line range for ${path}: ${raw.lineStart}-${raw.lineEnd}`);
  }
  const actual = lines.slice(raw.lineStart - 1, raw.lineEnd).join("\n");
  const claimed = raw.excerpt.replace(/\r\n/g, "\n").trim();
  if (!actual.includes(claimed)) {
    throw new Error(`evidence excerpt does not match ${path}:${raw.lineStart}-${raw.lineEnd}`);
  }
  return {
    path,
    lineStart: raw.lineStart,
    lineEnd: raw.lineEnd,
    excerpt: sanitizeSecurityText(claimed, 2_000),
  };
}

export function validateAgentFindings(workspace: string, raw: string, maxFindings = 50): ValidatedAgentFinding[] {
  if (!Number.isSafeInteger(maxFindings) || maxFindings < 1 || maxFindings > MAX_FINDINGS) {
    throw new Error(`maxFindings must be an integer from 1 to ${MAX_FINDINGS}`);
  }
  const parsed = agentScanEnvelopeSchema.parse(parseExactJsonObject(raw));
  if (parsed.findings.length > maxFindings) {
    throw new Error(`agent returned ${parsed.findings.length} findings; maximum is ${maxFindings}`);
  }
  return parsed.findings.map((finding) => ({
    title: sanitizeSecurityText(finding.title, 300),
    description: sanitizeSecurityText(finding.description),
    severity: finding.severity,
    confidence: finding.confidence,
    category: sanitizeSecurityText(finding.category, 200),
    ...(finding.cwe ? { cwe: sanitizeSecurityText(finding.cwe, 64) } : {}),
    ruleId: sanitizeSecurityText(finding.ruleId, 200),
    recommendation: sanitizeSecurityText(finding.recommendation),
    evidence: finding.evidence.map((evidence) => validateEvidence(workspace, evidence)),
  }));
}

export function validateEvidenceLocation(
  workspace: string,
  evidence: { path: string; lineStart: number; lineEnd: number },
): { path: string; lineStart: number; lineEnd: number } {
  const path = validateRelativeEvidencePath(workspace, evidence.path);
  const lineCount = readFileSync(resolveForRead(workspace, path), "utf8").replace(/\r\n/g, "\n").split("\n").length;
  if (
    !Number.isSafeInteger(evidence.lineStart) ||
    !Number.isSafeInteger(evidence.lineEnd) ||
    evidence.lineStart < 1 ||
    evidence.lineEnd < evidence.lineStart ||
    evidence.lineEnd > lineCount
  ) {
    throw new Error(`invalid evidence line range for ${path}: ${evidence.lineStart}-${evidence.lineEnd}`);
  }
  return { path, lineStart: evidence.lineStart, lineEnd: evidence.lineEnd };
}
