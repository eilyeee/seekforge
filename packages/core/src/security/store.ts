import { closeSync, chmodSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { resolveForWrite } from "../tools/sandbox.js";
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  VERIFICATION_STATUSES,
  type Finding,
  type FindingStatus,
  type SecurityEvent,
  type SecurityState,
  type VerificationStatus,
} from "./types.js";
import { sanitizeSecurityText } from "./redact.js";

const eventBaseSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(200),
  at: z.string().datetime(),
});

const evidenceSchema = z
  .object({
    path: z.string().min(1).max(1_000),
    lineStart: z.number().int().positive(),
    lineEnd: z.number().int().positive(),
    excerpt: z.string().max(2_100),
  })
  .strict();
const sourceSchema = z
  .object({
    scanner: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    ruleId: z.string().min(1).max(200),
  })
  .strict();
const findingSchema = z
  .object({
    id: z.string().min(1).max(200),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(8_100),
    severity: z.enum(FINDING_SEVERITIES),
    confidence: z.enum(["low", "medium", "high"]),
    category: z.string().min(1).max(200),
    cwe: z.string().max(64).optional(),
    recommendation: z.string().min(1).max(8_100),
    evidence: z.array(evidenceSchema).min(1).max(5),
    source: sourceSchema,
    status: z.enum(FINDING_STATUSES),
    verificationStatus: z.enum(VERIFICATION_STATUSES),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    scanRunId: z.string().min(1).max(200),
  })
  .strict();
const scanSchema = z
  .object({
    id: z.string().min(1).max(200),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: z.enum(["running", "completed", "failed"]),
    scanner: z.string().min(1).max(200),
    scannerVersion: z.string().min(1).max(100),
    findingIds: z.array(z.string().min(1).max(200)).max(100),
    error: z.string().max(2_100).optional(),
  })
  .strict();
const commandResultSchema = z
  .object({
    kind: z.enum(["verify", "lint"]),
    command: z.string().max(2_100),
    exitCode: z.number().int(),
    stdout: z.string().max(20_100),
    stderr: z.string().max(20_100),
    durationMs: z.number().int().nonnegative(),
    timedOut: z.boolean(),
  })
  .strict();
const fixSchema = z
  .object({
    id: z.string().min(1).max(200),
    findingId: z.string().min(1).max(200),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: z.enum(["running", "agent_failed", "verification_failed", "verified"]),
    sessionCompleted: z.boolean().optional(),
    commands: z.array(commandResultSchema).max(10),
    scanRunId: z.string().max(200).optional(),
    notes: z.string().max(2_100).optional(),
  })
  .strict();
const locationSchema = evidenceSchema.omit({ excerpt: true });
const threatModelItemSchema = z
  .object({
    name: z.string().min(1).max(300),
    description: z.string().min(1).max(4_100),
    evidence: z.array(locationSchema).min(1).max(10),
  })
  .strict();
const threatSchema = z
  .object({
    id: z.string().min(1).max(200),
    title: z.string().min(1).max(300),
    scenario: z.string().min(1).max(6_100),
    affectedAssets: z.array(z.string().max(300)).max(20),
    entryPoints: z.array(z.string().max(300)).max(20),
    trustBoundaries: z.array(z.string().max(300)).max(20),
    mitigations: z.array(z.string().max(2_100)).max(30),
    severity: z.enum(FINDING_SEVERITIES),
    evidence: z.array(locationSchema).min(1).max(10),
  })
  .strict();
const threatModelSchema = z
  .object({
    id: z.string().min(1).max(200),
    createdAt: z.string().datetime(),
    repository: z.string().min(1).max(300),
    summary: z.string().min(1).max(8_100),
    assets: z.array(threatModelItemSchema).max(50),
    entryPoints: z.array(threatModelItemSchema).max(50),
    trustBoundaries: z.array(threatModelItemSchema).max(50),
    dataFlows: z.array(threatModelItemSchema).max(50),
    threats: z.array(threatSchema).max(100),
  })
  .strict();

const securityEventSchema = z.discriminatedUnion("type", [
  eventBaseSchema.extend({ type: z.literal("scan.started"), scan: scanSchema }).strict(),
  eventBaseSchema
    .extend({
      type: z.literal("scan.completed"),
      scanId: z.string().min(1).max(200),
      status: z.enum(["completed", "failed"]),
      findingIds: z.array(z.string().min(1).max(200)).max(100),
      error: z.string().max(2_100).optional(),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal("finding.detected"), finding: findingSchema }).strict(),
  eventBaseSchema
    .extend({
      type: z.literal("finding.status_changed"),
      findingId: z.string().min(1).max(200),
      from: z.enum(FINDING_STATUSES),
      to: z.enum(FINDING_STATUSES),
      reason: z.string().min(1).max(2_100),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal("finding.verification_changed"),
      findingId: z.string().min(1).max(200),
      from: z.enum(VERIFICATION_STATUSES),
      to: z.enum(VERIFICATION_STATUSES),
      reason: z.string().min(1).max(2_100),
      scanRunId: z.string().max(200).optional(),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal("fix.started"), fix: fixSchema }).strict(),
  eventBaseSchema.extend({ type: z.literal("fix.completed"), fix: fixSchema }).strict(),
  eventBaseSchema.extend({ type: z.literal("threat_model.created"), threatModel: threatModelSchema }).strict(),
]);

const allowedTransitions: Record<FindingStatus, ReadonlySet<FindingStatus>> = {
  open: new Set(["triaged", "fixing", "resolved", "accepted_risk", "dismissed"]),
  triaged: new Set(["fixing", "resolved", "accepted_risk", "dismissed", "reopened"]),
  fixing: new Set(["open", "resolved", "reopened"]),
  resolved: new Set(["reopened"]),
  accepted_risk: new Set(["reopened"]),
  dismissed: new Set(["reopened"]),
  reopened: new Set(["triaged", "fixing", "resolved", "accepted_risk", "dismissed"]),
};

export function securityEventsPath(workspace: string): string {
  return resolveForWrite(workspace, join(".seekforge", "security", "events.jsonl"));
}

export function newSecurityEventId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function appendSecurityEvent(workspace: string, event: SecurityEvent): void {
  securityEventSchema.parse(event);
  const target = securityEventsPath(workspace);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  chmodSync(dirname(target), 0o700);
  const fd = openSync(target, "a", 0o600);
  try {
    chmodSync(target, 0o600);
    writeSync(fd, `${JSON.stringify(event)}\n`, undefined, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readSecurityEvents(workspace: string): SecurityEvent[] {
  const target = securityEventsPath(workspace);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: SecurityEvent[] = [];
  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
      parsed = securityEventSchema.parse(parsed);
    } catch (error) {
      throw new Error(
        `invalid security event at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    events.push(parsed as SecurityEvent);
  }
  return events;
}

export function buildSecurityState(workspace: string): SecurityState {
  const state: SecurityState = {
    findings: new Map(),
    scans: new Map(),
    fixes: new Map(),
    threatModels: new Map(),
    events: readSecurityEvents(workspace),
  };
  for (const event of state.events) {
    switch (event.type) {
      case "scan.started":
        state.scans.set(event.scan.id, structuredClone(event.scan));
        break;
      case "scan.completed": {
        const scan = state.scans.get(event.scanId);
        if (!scan) throw new Error(`security event ${event.id} completes unknown scan ${event.scanId}`);
        if (scan.status !== "running") throw new Error(`security scan ${event.scanId} is already complete`);
        scan.status = event.status;
        scan.completedAt = event.at;
        scan.findingIds = [...event.findingIds];
        if (event.error !== undefined) scan.error = event.error;
        break;
      }
      case "finding.detected": {
        const existing = state.findings.get(event.finding.id);
        const finding = structuredClone(event.finding);
        if (existing) {
          finding.firstSeenAt = existing.firstSeenAt;
          finding.status = existing.status;
          finding.verificationStatus = existing.verificationStatus;
        }
        state.findings.set(finding.id, finding);
        break;
      }
      case "finding.status_changed": {
        const finding = state.findings.get(event.findingId);
        if (!finding) throw new Error(`security event ${event.id} references unknown finding ${event.findingId}`);
        if (finding.status !== event.from) {
          throw new Error(
            `security event ${event.id} expected finding ${event.findingId} status ${event.from}, got ${finding.status}`,
          );
        }
        if (!allowedTransitions[event.from].has(event.to)) {
          throw new Error(`security event ${event.id} has invalid transition ${event.from} -> ${event.to}`);
        }
        finding.status = event.to;
        break;
      }
      case "finding.verification_changed": {
        const finding = state.findings.get(event.findingId);
        if (!finding) throw new Error(`security event ${event.id} references unknown finding ${event.findingId}`);
        if (finding.verificationStatus !== event.from) {
          throw new Error(
            `security event ${event.id} expected verification ${event.from}, got ${finding.verificationStatus}`,
          );
        }
        finding.verificationStatus = event.to;
        break;
      }
      case "fix.started":
      case "fix.completed":
        if (!state.findings.has(event.fix.findingId)) {
          throw new Error(`security event ${event.id} fixes unknown finding ${event.fix.findingId}`);
        }
        state.fixes.set(event.fix.id, structuredClone(event.fix));
        break;
      case "threat_model.created":
        state.threatModels.set(event.threatModel.id, structuredClone(event.threatModel));
        break;
    }
  }
  return state;
}

export function getFinding(workspace: string, findingId: string): Finding | undefined {
  const finding = buildSecurityState(workspace).findings.get(findingId);
  return finding ? structuredClone(finding) : undefined;
}

export function listFindings(
  workspace: string,
  filters: { status?: FindingStatus; severity?: (typeof FINDING_SEVERITIES)[number] } = {},
): Finding[] {
  if (filters.status !== undefined && !FINDING_STATUSES.includes(filters.status)) {
    throw new Error(`unknown finding status: ${filters.status}`);
  }
  if (filters.severity !== undefined && !FINDING_SEVERITIES.includes(filters.severity)) {
    throw new Error(`unknown finding severity: ${filters.severity}`);
  }
  return [...buildSecurityState(workspace).findings.values()]
    .filter((finding) => filters.status === undefined || finding.status === filters.status)
    .filter((finding) => filters.severity === undefined || finding.severity === filters.severity)
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id));
}

export function changeFindingStatus(workspace: string, findingId: string, to: FindingStatus, reason: string): Finding {
  if (!FINDING_STATUSES.includes(to)) throw new Error(`unknown finding status: ${to}`);
  const finding = getFinding(workspace, findingId);
  if (!finding) throw new Error(`finding not found: ${findingId}`);
  if (finding.status === to) return finding;
  if (!allowedTransitions[finding.status].has(to)) {
    throw new Error(`invalid finding transition: ${finding.status} -> ${to}`);
  }
  const at = new Date().toISOString();
  appendSecurityEvent(workspace, {
    version: 1,
    id: newSecurityEventId("status"),
    at,
    type: "finding.status_changed",
    findingId,
    from: finding.status,
    to,
    reason: sanitizeSecurityText(reason || "status changed", 2_000),
  });
  return { ...finding, status: to };
}

export function changeFindingVerification(
  workspace: string,
  findingId: string,
  to: VerificationStatus,
  reason: string,
  scanRunId?: string,
): Finding {
  if (!VERIFICATION_STATUSES.includes(to)) throw new Error(`unknown verification status: ${to}`);
  const finding = getFinding(workspace, findingId);
  if (!finding) throw new Error(`finding not found: ${findingId}`);
  if (finding.verificationStatus === to && scanRunId === undefined) return finding;
  const at = new Date().toISOString();
  appendSecurityEvent(workspace, {
    version: 1,
    id: newSecurityEventId("verification"),
    at,
    type: "finding.verification_changed",
    findingId,
    from: finding.verificationStatus,
    to,
    reason: sanitizeSecurityText(reason || "verification changed", 2_000),
    ...(scanRunId ? { scanRunId } : {}),
  });
  return { ...finding, verificationStatus: to };
}
